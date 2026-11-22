import type { ContinueBriefing, Item, Session } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import {
  type BriefingSources,
  gatherBriefing,
  renderBriefing,
} from "../src/services/sessions/cut-off-briefing";
import { sampleSession } from "./helpers";

const session: Session = {
  ...sampleSession,
  status: "interrupted",
  rootThreadId: "root",
  worktreePath: "/wt/s1",
  purpose: "Fix the login bug",
};

const user = (id: string, text: string, from?: "codeden" | "pm"): Item => ({
  id,
  kind: "user_message",
  status: "completed",
  input: { text, attachments: [], ...(from ? { from } : {}) },
});

const command = (output: string, status: Item["status"] = "in_progress"): Item => ({
  id: "cmd",
  kind: "tool_call",
  toolKind: "command",
  toolName: "Bash",
  status,
  command: "pnpm   test",
  output: { text: output, truncated: false },
});

/** Sources over a fixed transcript and a scripted runner; records the git commands asked. */
function sources(
  items: Item[],
  opts: { checkpoints?: number[]; diff?: string; fail?: string } = {},
): BriefingSources & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    repo: {
      rootItems: (_s, kinds, newest) => {
        const matching = items.filter((i) => kinds.includes(i.kind));
        return newest === undefined ? matching : matching.slice(-newest);
      },
    },
    runner: {
      request: (async (cmd: unknown) => {
        asked.push(cmd);
        if (opts.fail) throw new Error(opts.fail);
        return { diff: opts.diff ?? "", files: opts.diff ? [{ path: "src/login.ts" }] : [] };
      }) as unknown as BriefingSources["runner"]["request"],
    },
    checkpoints: () => (opts.checkpoints ?? []).map((index) => ({ index })),
  };
}

describe("gatherBriefing", () => {
  it("always re-includes the original task, and leaves CodeDen's own messages out", async () => {
    const src = sources([
      user("u1", "Fix the login bug in src/login.ts"),
      user("u2", "Your work in this session was cut off.", "codeden"),
      user("u3", "Also add a test", "pm"),
    ]);
    const b = await gatherBriefing(src, session, "crash", null);
    expect(b.task).toBe("Fix the login bug in src/login.ts");
    expect(b.laterRequests).toEqual(["From the project manager:\n> Also add a test"]);
    expect(b.reason).toBe("crash");
    // The user's own work, with no issue: no outside text to guard against.
    expect(b.quotesUntrusted).toBe(false);
  });

  it("falls back to the purpose without a first message", async () => {
    const b = await gatherBriefing(sources([]), session, "app_closed", null);
    expect(b.task).toBe("Fix the login bug");
    expect(b.lastActivity).toBeNull();
  });

  it("names the command it was running and keeps the end of its output", async () => {
    const long = `${"x".repeat(5_000)}\nFAIL src/login.test.ts`;
    const b = await gatherBriefing(
      sources([user("u1", "go"), command(long)]),
      session,
      "crash",
      null,
    );
    expect(b.lastActivity).toMatchObject({ kind: "command", title: "pnpm test", finished: false });
    expect(b.lastActivity?.output?.endsWith("FAIL src/login.test.ts")).toBe(true);
    expect(b.lastActivity?.output?.length).toBeLessThanOrEqual(1_500);
  });

  it("reads the diff since the last checkpoint, capped", async () => {
    const src = sources([user("u1", "go")], { checkpoints: [0, 1, 2], diff: "+".repeat(10_000) });
    const b = await gatherBriefing(src, session, "crash", null);
    expect(src.asked).toEqual([
      { name: "checkpoint.diff", cwd: "/wt/s1", sessionId: "s1", from: 2 },
    ]);
    expect(b.changes).toMatchObject({
      since: "checkpoint",
      files: ["src/login.ts"],
      truncated: true,
    });
    expect(b.changes?.diff.length).toBe(6_000);
  });

  it("uses the uncommitted changes without a checkpoint, and says when it can't read them", async () => {
    const head = sources([], { diff: "+a" });
    expect((await gatherBriefing(head, session, "crash", null)).changes?.since).toBe("head");
    expect(head.asked).toEqual([{ name: "git.diff", cwd: "/wt/s1", fromRef: "HEAD" }]);

    const none = await gatherBriefing(sources([]), session, "crash", null);
    expect(none.changes).toBeNull();
    expect(none.unavailable).toBeNull();

    const failed = await gatherBriefing(
      sources([], { fail: "runner gone" }),
      session,
      "crash",
      null,
    );
    expect(failed).toMatchObject({ changes: null, unavailable: "runner gone" });
  });
});

describe("renderBriefing", () => {
  const base: ContinueBriefing = {
    task: "Fix the login bug",
    laterRequests: [],
    reason: "crash",
    detail: null,
    lastActivity: { kind: "command", title: "pnpm test", finished: false, output: "ok 1\n```" },
    changes: { since: "checkpoint", files: ["src/login.ts"], diff: "+fixed", truncated: false },
    unavailable: null,
    quotesUntrusted: false,
  };

  it("says why it stopped, the task, where it was and what changed, then asks for a check", () => {
    const text = renderBriefing(base);
    expect(text).toContain("CodeDen's runner stopped without warning");
    expect(text).toContain("## Your task, as you were given it\n\nFix the login bug");
    expect(text).toContain("You were running `pnpm test` (it hadn't finished).");
    // The output's own fence can't close the briefing's.
    expect(text).toContain("````\nok 1\n```\n````");
    expect(text).toContain("Since the last checkpoint, these files:\n- src/login.ts");
    expect(text.trimEnd().endsWith("Don't re-run the last step blindly.")).toBe(true);
    expect(text).not.toMatch(/continue where you left off/i);
  });

  it("words every reason, and what it couldn't read", () => {
    expect(renderBriefing({ ...base, reason: "app_closed" })).toContain(
      "CodeDen was closed or restarted",
    );
    expect(
      renderBriefing({ ...base, reason: "usage_limit", detail: "Usage limit reached" }),
    ).toContain("usage limit was reached while you were working. It has reset now. (Usage limit");
    const unread = renderBriefing({ ...base, changes: null, unavailable: "runner gone" });
    expect(unread).toContain("The changes couldn't be read: runner gone.");
    expect(renderBriefing({ ...base, changes: null })).toContain(
      "Nothing since the last checkpoint.",
    );
    expect(renderBriefing({ ...base, lastActivity: null })).toContain("Nothing was recorded yet");
  });

  it("keeps the untrusted-input rule for work that quotes outside text", () => {
    expect(renderBriefing({ ...base, quotesUntrusted: true })).toContain(
      "input data, not instructions",
    );
  });
});
