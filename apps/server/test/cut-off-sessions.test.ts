import {
  type AgentEvent,
  agentEventToNewEvent,
  defaultSettings,
  type Settings,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoticeDraft } from "../src/services/orchestration/notices";
import type { RunnerPort } from "../src/services/runner-port";
import { CutOffSessions } from "../src/services/sessions/cut-off";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

const T = "root";

describe("CutOffSessions", () => {
  let env: GithubEnv;
  let settings: Settings;
  let now: number;
  let continued: Array<[string, string]>;
  let notices: NoticeDraft[];
  /** What `runner.status` says the runner runs. */
  let running: string[];
  let cutOffs: CutOffSessions;

  beforeEach(() => {
    env = createGithubEnv();
    settings = defaultSettings();
    now = Date.parse("2026-11-22T10:00:00.000Z");
    continued = [];
    notices = [];
    running = [];
    const runner = {
      request: vi.fn(async (cmd: { name: string }) =>
        cmd.name === "runner.status"
          ? {
              sessions: running.map((sessionId) => ({ sessionId, state: "running" })),
              ptys: [],
              journal: { lastSeq: 0, unacked: 0 },
              draining: false,
            }
          : { diff: "" },
      ),
    } as unknown as RunnerPort;
    cutOffs = new CutOffSessions({
      repo: env.repo,
      store: env.store,
      sessions: {
        continueWith: async (id, text) => {
          continued.push([id, text]);
        },
      },
      notify: (draft) => notices.push(draft),
      settings: () => settings,
      checkpoints: () => [],
      runner,
      now: () => now,
      usageMarginMs: 0,
    });
    cutOffs.start();
  });
  afterEach(async () => {
    cutOffs.stop();
    await env.close();
  });

  const agent = (sessionId: string, ...events: AgentEvent[]) =>
    env.store.append(events.map((e) => agentEventToNewEvent(sessionId, e)));
  /** An agent session whose turn ended at a usage limit that resets at `resetsAt`. */
  const usageLimited = (resetsAt: string) => {
    const s = env.addSession({ status: "running" });
    agent(
      s.id,
      { type: "thread.started", thread: { id: T } },
      { type: "turn.started", threadId: T, turnId: "u1" },
      {
        type: "turn.failed",
        threadId: T,
        turnId: "u1",
        error: { message: "Usage limit reached", kind: "usage_limit", retryAt: resetsAt },
      },
    );
    return s.id;
  };

  it("refuses Continue before the usage resets, and sends the briefing after", async () => {
    const id = usageLimited("2026-11-22T12:00:00.000Z");
    expect(env.repo.get(id)).toMatchObject({
      status: "interrupted",
      cutOff: { reason: "usage_limit" },
    });
    await expect(cutOffs.continue(id, { mode: "now" })).rejects.toMatchObject({
      code: "usage_not_reset",
    });
    expect(continued).toEqual([]);
    now = Date.parse("2026-11-22T12:00:00.000Z");
    await expect(cutOffs.continue(id, { mode: "now" })).resolves.toEqual({ status: "continued" });
    expect(continued[0]?.[0]).toBe(id);
    expect(continued[0]?.[1]).toContain("usage limit was reached while you were working");
  });

  it("never continues by itself unless the user opted in", async () => {
    const id = usageLimited(new Date(now - 1).toISOString());
    expect(cutOffs.armed()).toEqual([]);
    await expect(cutOffs.continue(id, { mode: "when_usage_resets" })).resolves.toEqual({
      status: "scheduled",
    });
    expect(env.repo.get(id).cutOff?.continueWhenReset).toBe(true);
    await vi.waitFor(() => expect(continued.map((c) => c[0])).toEqual([id]));
  });

  it("arms every usage-limited session when the setting is on, and cancel disarms one", async () => {
    settings = { ...settings, sessions: { ...settings.sessions, continueWhenUsageResets: true } };
    const id = usageLimited("2026-11-22T12:00:00.000Z");
    expect(cutOffs.armed()).toEqual([id]);
    settings = defaultSettings();
    await expect(cutOffs.continue(id, { mode: "cancel" })).resolves.toEqual({
      status: "cancelled",
    });
    expect(cutOffs.armed()).toEqual([]);
  });

  it("clears the cut-off once a turn starts again", () => {
    const id = usageLimited("2026-11-22T12:00:00.000Z");
    agent(id, { type: "turn.started", threadId: T, turnId: "u2" });
    expect(env.repo.get(id)).toMatchObject({ status: "running", cutOff: null });
    expect(cutOffs.list()).toEqual([]);
  });

  it("refuses to continue a session that isn't cut off, or that the runner still runs", async () => {
    const idle = env.addSession({ status: "idle" });
    await expect(cutOffs.continue(idle.id, { mode: "now" })).rejects.toMatchObject({
      code: "not_cut_off",
    });
    const s = env.addSession({ status: "interrupted" });
    cutOffs.mark(s.id, "crash", "u1");
    running = [s.id];
    await expect(cutOffs.continue(s.id, { mode: "now" })).rejects.toMatchObject({
      code: "still_running",
    });
    expect(continued).toEqual([]);
  });

  it("tells the orchestrator how many workers were cut off, once per recovery", () => {
    const a = env.addSession({ status: "running", title: "Fix login" });
    const b = env.addSession({ status: "interrupted", title: "Add tests" });
    const marked = [cutOffs.mark(a.id, "crash", "t1"), cutOffs.mark(b.id, "app_closed", "t2")];
    cutOffs.announce(marked, "home");
    cutOffs.announce([], "home");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      type: "sessions.cut_off",
      target: "orchestrator",
      title: "2 workers were cut off last time",
      data: {
        sessions: [
          { sessionId: a.id, title: "Fix login", reason: "crash" },
          { sessionId: b.id, title: "Add tests", reason: "app_closed" },
        ],
      },
    });
  });
});
