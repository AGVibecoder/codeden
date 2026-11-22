import type { CutOffReason, Session } from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RunnerPort, RunnerRouter } from "../src/services/runner-port";
import type { SessionLauncher } from "../src/services/sessions/launcher";
import { type RecoveryDeps, SessionRecovery } from "../src/services/sessions/recovery";
import type { SessionRepo } from "../src/services/sessions/repo";
import type { SessionService } from "../src/services/sessions/session-service";
import { sampleSession } from "./helpers";

/**
 * Cut-off detection after a runner connects (§4.2): a session counts as cut off only when its
 * log shows a turn that never ended and the runner, asked now, no longer hosts it. Nothing is
 * resumed: cut-off sessions are marked and announced, and wait for a Continue. Includes a
 * session started on that runner while its `runner.status` request is in flight (the CI flake
 * in restart-recovery.test.ts): it turns `running` before the reply is handled, and the reply
 * does not list it.
 */
describe("cut-off detection", () => {
  function setup(
    initial: Session[],
    runners?: (home: RunnerPort) => RunnerRouter,
    sweepVendorHistory?: RecoveryDeps["sweepVendorHistory"],
  ) {
    const sessions = new Map(initial.map((s) => [s.id, s]));
    const repo = {
      list: ({ status }: { status?: string[] }) =>
        [...sessions.values()].filter((s) => !status || status.includes(s.status)),
      find: (id: string) => {
        const session = sessions.get(id);
        return session ? { session } : undefined;
      },
      closeOrphanedTurns: vi.fn(() => 0),
      // Their cut-off turns are work turns (a cut-off compaction: compaction-restart.test.ts).
      rootTurnIds: (s: Session) => [`${s.id}-turn`],
      turn: () => null,
    } as unknown as SessionRepo;
    // Marking a session cut off, as `CutOffSessions.mark` does, and the orchestrator's notice.
    const mark = vi.fn((id: string, reason: CutOffReason, turnId: string | null): Session => {
      const s = sessions.get(id) as Session;
      const next: Session = {
        ...s,
        status: "interrupted",
        cutOff: { reason, at: s.updatedAt, turnId, resetsAt: null, continueWhenReset: false },
      };
      sessions.set(id, next);
      return next;
    });
    const announce = vi.fn((_cut: Session[], _key: string) => undefined);
    // Sessions with a message, Retry or queued delivery on its way to the runner.
    const delivering = new Set<string>();
    const service = {
      launching: new Map<string, Promise<void>>(),
      isDelivering: (id: string) => delivering.has(id),
      sessionsWithQueuedMessages: () => [],
      releaseOutboxes: () => undefined,
    } as unknown as SessionService;
    const fail = vi.fn();
    const launcher = { fail } as unknown as SessionLauncher;
    let onStatus: () => void = () => undefined;
    // The sessions the runner hosts right now (`runner.status` reports them).
    const hosted = new Set<string>();
    const runner = {
      request: vi.fn(async () => {
        onStatus();
        return {
          sessions: [...hosted].map((sessionId) => ({ sessionId })),
          ptys: [],
          journal: { lastSeq: 0, unacked: 0 },
          draining: false,
        };
      }),
      providers: () => [{ id: "fake", capabilities: { resume: true } }],
    } as unknown as RunnerPort;
    const recovery = new SessionRecovery({
      repo,
      sessions: service,
      launcher,
      cutOffs: { mark, announce },
      runner,
      runners: runners?.(runner),
      ...(sweepVendorHistory ? { sweepVendorHistory } : {}),
    });
    return {
      recovery,
      repo,
      sessions,
      mark,
      announce,
      fail,
      hosted,
      delivering,
      whileStatusInFlight: (fn: () => void) => {
        onStatus = fn;
      },
    };
  }

  const cut = { ...sampleSession, provider: "fake", resumeToken: "r" } as const;
  const marked = (t: ReturnType<typeof setup>) => t.mark.mock.calls.map((c) => c[0]);

  it("leaves alone a session that started while runner.status was in flight", async () => {
    const t = setup([{ ...sampleSession, id: "new", status: "starting", provider: "fake" }]);
    t.whileStatusInFlight(() => {
      const s = t.sessions.get("new");
      if (s) t.sessions.set("new", { ...s, status: "running" });
    });
    await t.recovery.onRunnerReady();
    expect(t.fail).not.toHaveBeenCalled();
    expect(t.mark).not.toHaveBeenCalled();
    expect(t.sessions.get("new")?.status).toBe("running");
  });

  it("marks a turn the runner vanished in as a crash, and a drained one as app closed", async () => {
    const t = setup([
      { ...cut, id: "crashed", status: "running" },
      { ...cut, id: "drained", status: "interrupted" },
    ]);
    await t.recovery.onRunnerReady();
    expect(t.mark.mock.calls).toEqual([
      ["crashed", "crash", "crashed-turn"],
      ["drained", "app_closed", "drained-turn"],
    ]);
    // Turns and approvals the dead runner left open are closed before it waits.
    expect(t.repo.closeOrphanedTurns).toHaveBeenCalledWith("crashed");
    expect(t.sessions.get("crashed")).toMatchObject({
      status: "interrupted",
      cutOff: { reason: "crash" },
    });
    expect(t.announce).toHaveBeenCalledTimes(1);
    expect(t.announce.mock.calls[0]?.[0].map((s) => s.id)).toEqual(["crashed", "drained"]);
    expect(t.fail).not.toHaveBeenCalled();
  });

  it("never calls a session cut off while the runner still hosts it", async () => {
    // The server restarted alone: the runner kept running the turn. Starting the session again
    // would run a second agent in the same worktree.
    const t = setup([{ ...cut, id: "alive", status: "running" }]);
    t.hosted.add("alive");
    await t.recovery.onRunnerReady();
    expect(t.mark).not.toHaveBeenCalled();
    expect(t.repo.closeOrphanedTurns).not.toHaveBeenCalled();
    expect(t.announce.mock.calls[0]?.[0]).toEqual([]);
    expect(t.sessions.get("alive")?.status).toBe("running");
  });

  it("leaves a session that is already cut off as it is", async () => {
    const waiting: Session = {
      ...cut,
      id: "waiting",
      status: "interrupted",
      cutOff: {
        reason: "usage_limit",
        at: cut.updatedAt,
        turnId: "t",
        resetsAt: null,
        continueWhenReset: false,
      },
    };
    const t = setup([waiting]);
    await t.recovery.onRunnerReady();
    expect(t.mark).not.toHaveBeenCalled();
    expect(t.sessions.get("waiting")?.cutOff?.reason).toBe("usage_limit");
  });

  it("only marks the sessions of the runner that became ready", async () => {
    const other = {
      request: vi.fn(async () => ({
        sessions: [],
        ptys: [],
        journal: { lastSeq: 0, unacked: 0 },
        draining: false,
      })),
      providers: () => [{ id: "fake", capabilities: { resume: true } }],
    } as unknown as RunnerPort;
    const t = setup(
      [
        { ...cut, id: "at-home", status: "running" },
        { ...cut, id: "on-b", status: "running", runnerId: "r-b" },
      ],
      (home) => ({
        home: () => home,
        forSession: (id) => (id === "on-b" ? other : home),
        forRunnerId: (runnerId) => (runnerId === "r-b" ? other : home),
      }),
    );
    await t.recovery.onRunnerReady("r-b");
    expect(other.request).toHaveBeenCalledWith({ name: "runner.status" }, 10_000);
    expect(marked(t)).toEqual(["on-b"]);
    await t.recovery.onRunnerReady("r-home");
    expect(marked(t)).toEqual(["on-b", "at-home"]);
  });

  it("leaves alone a session with a message on its way to the runner", async () => {
    const t = setup([
      { ...cut, id: "first", status: "running" },
      { ...cut, id: "second", status: "interrupted" },
    ]);
    // The user's message to "second" is being sent; the runner hasn't answered yet.
    t.delivering.add("second");
    await t.recovery.onRunnerReady();
    expect(marked(t)).toEqual(["first"]);
    expect(t.repo.closeOrphanedTurns).not.toHaveBeenCalledWith("second");
  });

  it("fails a session its provider can't resume: there is nothing to wait for", async () => {
    const t = setup([{ ...cut, id: "lost", status: "running", resumeToken: null }]);
    await t.recovery.onRunnerReady();
    expect(t.mark).not.toHaveBeenCalled();
    expect(t.fail).toHaveBeenCalledWith("lost", "restart", expect.any(Error));
  });

  it("then sweeps what a crash left in providers' own apps, after marking", async () => {
    const order: string[] = [];
    const sweep = vi.fn(async (_runner: RunnerPort, skip: (id: string) => boolean) => {
      order.push("sweep");
      expect(skip("on-its-way")).toBe(true);
      expect(skip("idle")).toBe(false);
      return { hidden: [], failed: 0 };
    });
    const t = setup([{ ...cut, id: "cut", status: "running" }], undefined, sweep);
    t.announce.mockImplementationOnce(() => {
      order.push("announce");
    });
    t.delivering.add("on-its-way");
    await t.recovery.onRunnerReady();
    await vi.waitFor(() => expect(order).toEqual(["announce", "sweep"]));
  });

  it("finishes recovery without waiting for the sweep, and recovers a reconnect during one", async () => {
    // The sweep takes a while (a short-lived provider process per provider).
    let finishSweep: () => void = () => undefined;
    const sweep = vi.fn(
      () =>
        new Promise<{ hidden: string[]; failed: number }>((resolve) => {
          finishSweep = () => resolve({ hidden: [], failed: 0 });
        }),
    );
    const t = setup([{ ...cut, id: "first", status: "running" }], undefined, sweep);

    let recovered = false;
    void t.recovery.onRunnerReady().then(() => {
      recovered = true;
    });
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(recovered).toBe(true));
    expect(marked(t)).toEqual(["first"]);

    // The runner drops and reconnects while the sweep still runs, cutting off another turn.
    t.sessions.set("second", { ...cut, id: "second", status: "running" });
    await t.recovery.onRunnerReady();
    expect(marked(t)).toEqual(["first", "second"]);
    // The reconnect's own sweep waits for the one in progress, then runs.
    expect(sweep).toHaveBeenCalledTimes(1);
    finishSweep();
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(2));
    finishSweep();
  });
});
