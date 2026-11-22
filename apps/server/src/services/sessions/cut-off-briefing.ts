import type {
  BriefingActivity,
  BriefingChanges,
  ContinueBriefing,
  CutOffReason,
  Item,
  ItemOf,
  Session,
} from "@codeden/contracts";
import { errorMessage } from "../errors";
import { UNTRUSTED_INPUT } from "../factory/prompts";
import type { RunnerPort } from "../runner-port";
import { clip, message, oneLine, quotesUntrustedInput } from "./handoff-brief";
import type { SessionRepo } from "./repo";
import { sessionWorkdir } from "./workdir";

const TASK_MAX = 4_000;
const REQUEST_MAX = 600;
const REQUESTS_SHOWN = 5;
const TITLE_MAX = 300;
/** The end of a command's output is what tells where it got to. */
const OUTPUT_MAX = 1_500;
const DIFF_MAX = 6_000;
const FILES_SHOWN = 40;
const DETAIL_MAX = 300;
const GIT_TIMEOUT_MS = 30_000;

/** What the briefing is read from: the session's log and its worktree. */
export interface BriefingSources {
  repo: Pick<SessionRepo, "rootItems">;
  /** The runner that hosts the session's worktree. */
  runner: Pick<RunnerPort, "request">;
  /** The session's checkpoints, oldest first. */
  checkpoints: (sessionId: string) => { index: number }[];
}

/**
 * Read a cut-off session's briefing (§4.2) from its log and worktree: its first message, later
 * requests, its last item, and the diff since its last checkpoint (uncommitted changes without
 * one). A diff the runner can't read is reported as such, never left out silently.
 */
export async function gatherBriefing(
  src: BriefingSources,
  session: Session,
  reason: CutOffReason,
  detail: string | null,
): Promise<ContinueBriefing> {
  const requests = src.repo
    .rootItems(session, ["user_message"])
    .filter((i): i is ItemOf<"user_message"> => i.kind === "user_message");
  const [first, ...later] = requests;
  const [last] = src.repo.rootItems(session, ["tool_call", "assistant_message"], 1);
  let changes: BriefingChanges | null = null;
  let unavailable: string | null = null;
  try {
    changes = await readChanges(src, session);
  } catch (error) {
    unavailable = errorMessage(error);
  }
  return {
    task: first ? message(first.input, TASK_MAX) : clip(session.purpose, TASK_MAX),
    laterRequests: later
      .filter((m) => m.input.from !== "codeden")
      .slice(-REQUESTS_SHOWN)
      .map((m) => message(m.input, REQUEST_MAX)),
    reason,
    detail: detail ? clip(oneLine(detail), DETAIL_MAX) : null,
    lastActivity: last ? activity(last) : null,
    changes,
    unavailable,
    quotesUntrusted: quotesUntrustedInput({ session, requests }),
  };
}

async function readChanges(
  src: BriefingSources,
  session: Session,
): Promise<BriefingChanges | null> {
  const cwd = sessionWorkdir(session);
  const latest = src.checkpoints(session.id).at(-1);
  const result = latest
    ? await src.runner.request(
        { name: "checkpoint.diff", cwd, sessionId: session.id, from: latest.index },
        GIT_TIMEOUT_MS,
      )
    : await src.runner.request({ name: "git.diff", cwd, fromRef: "HEAD" }, GIT_TIMEOUT_MS);
  if (!result.diff.trim()) return null;
  return {
    since: latest ? "checkpoint" : "head",
    files: (result.files ?? []).map((f) => f.path),
    diff: result.diff.length > DIFF_MAX ? result.diff.slice(0, DIFF_MAX) : result.diff,
    truncated: result.diff.length > DIFF_MAX,
  };
}

/** The last tool call or reply, as the briefing names it. */
export function activity(item: Item): BriefingActivity | null {
  const finished = item.status !== "in_progress";
  if (item.kind === "assistant_message") {
    const text = oneLine(item.text);
    return text ? { kind: "message", title: clip(text, TITLE_MAX), finished, output: null } : null;
  }
  if (item.kind !== "tool_call") return null;
  if (item.toolKind === "command") {
    const out = item.output?.text.trimEnd() ?? "";
    return {
      kind: "command",
      title: clip(oneLine(item.command), TITLE_MAX),
      finished,
      output: out ? tail(out, OUTPUT_MAX) : null,
    };
  }
  return {
    kind: "tool",
    title: clip(oneLine(item.title ?? item.toolName), TITLE_MAX),
    finished,
    output: null,
  };
}

const WHY: Record<CutOffReason, string> = {
  crash: "CodeDen's runner stopped without warning (a crash or a kill) while you were working.",
  app_closed: "CodeDen was closed or restarted while you were working.",
  usage_limit: "The provider's usage limit was reached while you were working. It has reset now.",
  error: "The provider failed with a passing error while you were working.",
};

/**
 * The briefing as CodeDen's message. Every section is short by construction (each part is
 * clipped when read), so nothing is cut here; the closing always asks for a check first.
 */
export function renderBriefing(b: ContinueBriefing): string {
  const parts = [
    "Your work in this session was cut off. This briefing is read from the session's log and worktree, so you can pick up without guessing.",
    b.quotesUntrusted ? UNTRUSTED_INPUT : "",
    `## Why it stopped\n\n${WHY[b.reason]}${b.detail ? ` (${b.detail})` : ""}`,
    `## Your task, as you were given it\n\n${b.task}`,
    b.laterRequests.length
      ? `## Later requests\n\n${b.laterRequests.map((r) => `- ${r.replace(/\n/g, "\n  ")}`).join("\n")}`
      : "",
    `## Where you were\n\n${where(b.lastActivity)}`,
    `## What you already changed\n\n${changed(b)}`,
    "## Next\n\nCheck where things stand first (`git status`, the changes above, whether your last step finished or left partial work), then decide how to pick up. Don't re-run the last step blindly.",
  ];
  return parts.filter(Boolean).join("\n\n");
}

function where(a: ContinueBriefing["lastActivity"]): string {
  if (!a) return "Nothing was recorded yet in this session.";
  const state = a.finished ? "it had finished" : "it hadn't finished";
  if (a.kind === "message") return `Your last reply (${state}):\n\n> ${a.title}`;
  if (a.kind === "tool") return `You were using a tool: ${a.title} (${state}).`;
  const head = `You were running \`${a.title}\` (${state}).`;
  return a.output ? `${head} Its output so far, the end of it:\n\n${fence(a.output)}` : head;
}

function changed(b: ContinueBriefing): string {
  if (b.unavailable) return `The changes couldn't be read: ${b.unavailable}. Check them yourself.`;
  const c = b.changes;
  if (!c) return "Nothing since the last checkpoint.";
  const since = c.since === "checkpoint" ? "Since the last checkpoint" : "Uncommitted";
  const files = c.files.slice(0, FILES_SHOWN).map((f) => `- ${f}`);
  if (c.files.length > FILES_SHOWN) files.push(`- and ${c.files.length - FILES_SHOWN} more`);
  const list = files.length ? `${since}, these files:\n${files.join("\n")}\n\n` : `${since}:\n\n`;
  const shortened = c.truncated ? "\n\n(The diff is shortened; run `git diff` for all of it.)" : "";
  return `${list}${fence(c.diff, "diff")}${shortened}`;
}

/** A code fence that the text inside can't close. */
function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}
