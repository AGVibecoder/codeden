import {
  type AgentEvent,
  agentEventToNewEvent,
  defaultSettings,
  type ErrorInfo,
  type Settings,
  type UserInput,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TurnRecord } from "../src/events/reducer/types";
import { AutoRetry, inAbout, planRetry } from "../src/services/sessions/auto-retry";
import { sampleSession } from "./helpers";
import { createGithubEnv, type GithubEnv } from "./support/github-env";
import { MemoryProjection } from "./support/memory-projection";

const T = "t-root";
const transient: ErrorInfo = {
  message: "API overloaded (529)",
  kind: "transient",
  retryable: true,
};
const usage = (retryAt: string): ErrorInfo => ({
  message: "Usage limit",
  kind: "usage_limit",
  retryable: true,
  retryAt,
});

describe("the reducer leaves passing failures of agent sessions to auto-retry", () => {
  const fail = (role: "agent" | "pm", error: ErrorInfo) => {
    const p = new MemoryProjection();
    p.addSession({ ...sampleSession, role, status: "starting", projectId: "p1" });
    p.apply(
      "s1",
      { type: "thread.started", thread: { id: T } },
      { type: "turn.started", threadId: T, turnId: "u1" },
      { type: "turn.failed", threadId: T, turnId: "u1", error },
    );
    return {
      status: p.session().status,
      inbox: [...p.inbox.values()].map((i) => i.kind),
      cutOff: p.session().cutOff ?? null,
    };
  };

  it("keeps the session idle with no inbox item for transient failures", () => {
    expect(fail("agent", transient)).toEqual({ status: "idle", inbox: [], cutOff: null });
  });

  it("cuts an agent off at a usage limit, waiting for the reset, with no inbox item", () => {
    const resets = "2026-11-10T20:00:00.000Z";
    expect(fail("agent", usage(resets))).toMatchObject({
      status: "interrupted",
      inbox: [],
      cutOff: { reason: "usage_limit", turnId: "u1", resetsAt: resets, continueWhenReset: false },
    });
  });

  it("fails everything else, and role sessions, at once", () => {
    const failed = { status: "failed", inbox: ["run_failed"], cutOff: null };
    expect(fail("agent", { message: "boom" })).toEqual(failed);
    expect(fail("agent", { message: "x", kind: "auth" })).toEqual(failed);
    expect(fail("pm", transient)).toEqual(failed);
    expect(fail("pm", usage("2026-11-10T20:00:00.000Z"))).toEqual(failed);
  });
});

describe("planRetry", () => {
  const turn = (
    id: string,
    at: string,
    error: ErrorInfo | null,
    status = "failed",
  ): TurnRecord => ({
    id,
    sessionId: "s1",
    threadId: T,
    status: status as TurnRecord["status"],
    startedAt: at,
    completedAt: at,
    error,
    usage: null,
  });
  const session = { ...sampleSession, status: "idle" as const, rootThreadId: T };
  const opts = { enabled: true, delaysMs: [20_000, 90_000, 300_000] };
  const at = "2026-11-10T10:00:00.000Z";
  const t0 = Date.parse(at);

  it("backs off 20 s, 90 s and 5 min, then gives up", () => {
    const one = [turn("u3", at, transient), turn("u2", at, null, "completed")];
    expect(planRetry(session, one, opts)).toMatchObject({
      action: "retry",
      attempt: 1,
      at: t0 + 20_000,
    });
    const three = [turn("u4", at, transient), turn("u3", at, transient), turn("u2", at, transient)];
    expect(planRetry(session, three, opts)).toMatchObject({ attempt: 3, at: t0 + 300_000 });
    const four = [turn("u5", at, transient), ...three];
    expect(planRetry(session, four, opts)).toMatchObject({ action: "give_up", exhausted: true });
  });

  it("does nothing once a newer turn ran, the session isn't idle, or it's an orchestrator", () => {
    const failed = [turn("u2", at, transient)];
    expect(planRetry(session, [turn("u3", at, null, "running"), ...failed], opts).action).toBe(
      "none",
    );
    expect(planRetry({ ...session, status: "stopped" }, failed, opts).action).toBe("none");
    expect(planRetry({ ...session, role: "orchestrator" }, failed, opts).action).toBe("none");
    expect(planRetry(session, [turn("u2", at, { message: "boom" })], opts).action).toBe("none");
  });

  it("fails as before when switched off", () => {
    expect(
      planRetry(session, [turn("u2", at, transient)], { ...opts, enabled: false }),
    ).toMatchObject({ action: "give_up", exhausted: false });
  });

  it("words the wait", () => {
    expect(inAbout(20_000)).toBe("in 20s");
    expect(inAbout(90_000)).toBe("in 2 min");
    expect(inAbout(2 * 3_600_000 + 15 * 60_000)).toBe("in about 2 h 15 min");
  });
});

describe("AutoRetry", () => {
  let env: GithubEnv;
  let settings: Settings;
  let sent: Array<{ sessionId: string; input: UserInput }>;
  let retry: AutoRetry;
  let turnNo = 0;

  const make = () =>
    new AutoRetry({
      db: env.db.db,
      store: env.store,
      repo: env.repo,
      inbox: env.inbox,
      settings: () => settings,
      briefing: async (session, error) => `briefing for ${session.id}: ${error.message}`,
      send: async (sessionId, input) => {
        sent.push({ sessionId, input });
      },
      delaysMs: [30, 30, 30],
    });

  beforeEach(() => {
    env = createGithubEnv();
    settings = defaultSettings();
    sent = [];
    turnNo = 0;
    retry = make();
    retry.start();
  });
  afterEach(async () => {
    retry.stop();
    await env.close();
  });

  const agent = (sessionId: string, ...events: AgentEvent[]) =>
    env.store.append(events.map((e) => agentEventToNewEvent(sessionId, e)));
  const failTurn = (sessionId: string, error: ErrorInfo) => {
    const turnId = `u${++turnNo}`;
    agent(
      sessionId,
      { type: "turn.started", threadId: T, turnId },
      { type: "turn.failed", threadId: T, turnId, error },
    );
    return turnId;
  };
  const newSession = () => {
    const s = env.addSession({ status: "running" });
    agent(s.id, { type: "thread.started", thread: { id: T } });
    return s.id;
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await wait(10);
    }
  };
  const notice = (id: string, turnId: string) => {
    const item = env.repo.item(id, `auto-retry-${turnId}`)?.item;
    return item?.kind === "notice" ? item : undefined;
  };
  const runFailed = () => env.inbox.list().filter((i) => i.kind === "run_failed");

  it("retries the session with its briefing after a transient failure, and says so", async () => {
    const id = newSession();
    const turnId = failTurn(id, transient);
    await until(() => sent.length === 1);
    expect(sent[0]).toEqual({
      sessionId: id,
      input: {
        text: `briefing for ${id}: API overloaded (529)`,
        attachments: [],
        from: "codeden",
      },
    });
    expect(notice(id, turnId)?.message).toMatch(
      /^Retrying automatically in 1s \(attempt 1 of 3\)\.$/,
    );
    expect(env.repo.get(id).status).toBe("idle");
    expect(runFailed()).toEqual([]);
  });

  it("gives up after three retries in a row and fails the session as before", async () => {
    const id = newSession();
    for (let n = 1; n <= 3; n++) {
      failTurn(id, transient);
      await until(() => sent.length === n);
    }
    const last = failTurn(id, transient);
    await until(() => env.repo.get(id).status === "failed");
    expect(sent).toHaveLength(3);
    expect(runFailed()).toMatchObject([
      { id: `inbox:${id}:${last}:failed`, body: transient.message },
    ]);
    expect(notice(id, last)?.message).toBe("Stopped retrying after 3 automatic retries.");
  });

  it("leaves a usage limit alone: the session is cut off, not retried", async () => {
    const id = newSession();
    failTurn(id, usage(new Date(Date.now() + 50).toISOString()));
    await wait(150);
    expect(sent).toHaveLength(0);
    expect(retry.pending()).toEqual([]);
    expect(env.repo.get(id)).toMatchObject({
      status: "interrupted",
      cutOff: { reason: "usage_limit" },
    });
  });

  it("is cancelled by a message from the user, or by Stop", async () => {
    retry.stop();
    retry = new AutoRetry({
      db: env.db.db,
      store: env.store,
      repo: env.repo,
      inbox: env.inbox,
      settings: () => settings,
      briefing: async () => "briefing",
      send: async (sessionId, input) => {
        sent.push({ sessionId, input });
      },
      delaysMs: [5_000],
    });
    retry.start();
    const a = newSession();
    const failedA = failTurn(a, transient);
    await until(() => retry.pending().includes(a));
    agent(a, { type: "turn.started", threadId: T, turnId: "user-turn" });
    expect(retry.pending()).not.toContain(a);
    expect(notice(a, failedA)?.message).toBe(
      "A new message was sent, so the automatic retry was cancelled.",
    );

    const b = newSession();
    failTurn(b, transient);
    await until(() => retry.pending().includes(b));
    env.repo.update(b, (s) => ({ ...s, status: "stopped" }));
    expect(retry.pending()).not.toContain(b);
    expect(sent).toHaveLength(0);
    expect(runFailed()).toEqual([]);
  });

  it("fails at once when switched off", async () => {
    settings = { ...settings, sessions: { ...settings.sessions, autoRetry: false } };
    const id = newSession();
    const turnId = failTurn(id, transient);
    await until(() => env.repo.get(id).status === "failed");
    expect(runFailed()).toMatchObject([{ id: `inbox:${id}:${turnId}:failed` }]);
    expect(sent).toHaveLength(0);
    expect(notice(id, turnId)).toBeUndefined();
  });

  it("picks pending retries up again after a restart", async () => {
    retry.stop();
    const id = newSession();
    failTurn(id, transient);
    await wait(20);
    expect(sent).toHaveLength(0);
    retry = make();
    retry.start();
    await until(() => sent.length === 1);
    expect(sent[0]?.sessionId).toBe(id);
  });
});
