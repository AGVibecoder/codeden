import { GITHUB_NOTICE_TYPES, type GithubUpdatesLevel, type NoticeType } from "@codeden/contracts";
import type { NoticeDraft } from "./notices";

/**
 * Where a notice goes in the PM's next turn: `live` (a card in the chat, in full in the prompt),
 * `summary` (one line of the short GitHub summary, no card) or `hidden` (nowhere; the activity
 * stays on the project page).
 */
export type NoticePresentation = "live" | "summary" | "hidden";

/**
 * Whether a GitHub notice is about the project's own work: a PR a CodeDen session opened that
 * failed its checks, got changes requested by someone with write access, merged or ran into a
 * merge conflict. Everything else (new issues, other people's PRs, passing checks, approvals)
 * is not.
 */
export function isOwnWork(n: NoticeDraft): boolean {
  switch (n.type) {
    case "pr.checks_failed":
    case "pr.merged":
    case "pr.conflicting":
      return n.data.sessionId !== null;
    case "review.submitted":
      return n.data.sessionId !== null && n.data.state === "changes_requested" && !n.data.untrusted;
    default:
      return false;
  }
}

/** Where `n` goes at the project's GitHub updates `level`. Notices from elsewhere are live. */
export function presentation(n: NoticeDraft, level: GithubUpdatesLevel): NoticePresentation {
  if (!GITHUB_NOTICE_TYPES.has(n.type)) return "live";
  switch (level) {
    case "off":
      return "hidden";
    case "digest":
      return "summary";
    case "important":
      return isOwnWork(n) ? "live" : "summary";
    case "all":
      return "live";
  }
}

const SUMMARY_LABELS: Partial<Record<NoticeType, [one: string, many: string]>> = {
  "issue.opened": ["issue opened", "issues opened"],
  "pr.opened": ["PR opened", "PRs opened"],
  "pr.checks_failed": ["PR failed its checks", "PRs failed their checks"],
  "pr.checks_passed": ["PR passed its checks", "PRs passed their checks"],
  "pr.merged": ["PR merged", "PRs merged"],
  "pr.conflicting": ["PR has merge conflicts", "PRs have merge conflicts"],
  "review.submitted": ["review", "reviews"],
};

function numberOf(n: NoticeDraft): number | null {
  if (n.type === "issue.opened") return n.data.issue.number;
  return "pr" in n.data ? n.data.pr.number : null;
}

/**
 * The short GitHub summary for a PM's turn: counts per kind with their numbers, e.g.
 * "3 issues opened (#12, #13, #15)". The project's level keeps these out of the chat.
 */
export function renderGithubSummary(list: NoticeDraft[]): string {
  const groups = new Map<NoticeType, number[]>();
  for (const n of list) {
    const numbers = groups.get(n.type) ?? [];
    const number = numberOf(n);
    if (number !== null && !numbers.includes(number)) numbers.push(number);
    groups.set(n.type, numbers);
  }
  const parts = [...groups].map(([type, numbers]) => {
    const [one, many] = SUMMARY_LABELS[type] ?? [type, type];
    const count = Math.max(numbers.length, 1);
    const refs = numbers.length ? ` (${numbers.map((x) => `#${x}`).join(", ")})` : "";
    return `${count} ${count === 1 ? one : many}${refs}`;
  });
  return [
    "<codeden_github_summary>",
    `GitHub since your last turn: ${parts.join("; ")}.`,
    "The project's GitHub updates level keeps these out of the chat. Look them up with your GitHub tools only when they matter to your work.",
    "</codeden_github_summary>",
  ].join("\n");
}

export interface GithubWakeThrottleOptions {
  /** Shortest time between two GitHub wakes of one target (default 15 minutes). */
  intervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Batches GitHub wakes at the `all` level: a target is woken for GitHub activity at most once
 * per interval. Activity arriving sooner waits for the interval to pass and then goes out as
 * one wake; whatever reached the target with another turn meanwhile is already delivered.
 */
export class GithubWakeThrottle {
  private readonly last = new Map<string, number>();
  private readonly waiting = new Map<string, unknown>();
  private readonly opts: Required<GithubWakeThrottleOptions>;

  constructor(
    private readonly wake: (key: string) => void,
    opts: GithubWakeThrottleOptions = {},
  ) {
    this.opts = {
      intervalMs: opts.intervalMs ?? 15 * 60_000,
      now: opts.now ?? Date.now,
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)),
    };
  }

  /** GitHub activity for `key` asks for a wake. */
  request(key: string): void {
    if (this.waiting.has(key)) return;
    const now = this.opts.now();
    const last = this.last.get(key);
    if (last === undefined || now - last >= this.opts.intervalMs) {
      this.send(key);
      return;
    }
    const timer = this.opts.setTimer(
      () => {
        this.waiting.delete(key);
        this.send(key);
      },
      last + this.opts.intervalMs - now,
    );
    this.waiting.set(key, timer);
  }

  dispose(): void {
    for (const timer of this.waiting.values()) this.opts.clearTimer(timer);
    this.waiting.clear();
  }

  private send(key: string): void {
    this.last.set(key, this.opts.now());
    this.wake(key);
  }
}
