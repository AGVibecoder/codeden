import type { CutOffReason, ProviderInfo, Session } from "@codeden/contracts";
import { errorMessage } from "../errors";
import { type RunnerDeps, type RunnerPort, runnerForSession } from "../runner-port";
import { lastCompaction } from "./compact";
import type { CutOffSessions } from "./cut-off";
import type { SessionLauncher } from "./launcher";
import type { SessionRepo } from "./repo";
import type { SessionService } from "./session-service";

export interface RecoveryDeps extends RunnerDeps {
  repo: SessionRepo;
  sessions: SessionService;
  launcher: SessionLauncher;
  cutOffs: Pick<CutOffSessions, "mark" | "announce">;
  /**
   * After recovery: hide the provider conversations a crash or kill left in a provider's own
   * apps, skipping sessions given to `skip` (`ProviderHistoryService.sweep`).
   */
  sweepVendorHistory?: (
    runner: RunnerPort,
    skip: (sessionId: string) => boolean,
  ) => Promise<{ hidden: string[]; failed: number }>;
  log?: (message: string) => void;
}

const UNSETTLED = ["running", "waiting", "interrupted"] as const;
const isUnsettled = (status: string) => (UNSETTLED as readonly string[]).includes(status);

/**
 * After a runner (re)connects: find its sessions whose turn a runner drain, restart or crash cut
 * off, and mark them cut off (§4.2) so they wait, red, for a Continue; nothing resumes them by
 * itself. A session counts as cut off only when its log shows a turn that never ended and the
 * runner, asked now, no longer hosts it: a runner that kept running (the server restarted
 * alone) still owns its turns, and starting the session again would run it twice. A cut-off
 * compaction goes idle instead (there is nothing to continue). Then the messages that were
 * queued before a server restart are delivered. Only sessions that runner hosts
 * (`sessions.runnerId`, else the home runner) are touched.
 */
export class SessionRecovery {
  private readonly running = new Map<string, Promise<void>>();
  /** The vendor-history sweep in progress (or queued) for each runner. */
  private readonly sweeping = new Map<string, Promise<void>>();

  constructor(private readonly deps: RecoveryDeps) {}

  /**
   * Called when a current runner is connected and configured; `runnerId` is its journal id
   * (omitted: the home runner). Resolves once recovery is done; the sweep that follows runs on
   * its own, so it never holds recovery up, and a runner that reconnects meanwhile is recovered
   * again rather than waiting on it. Never throws.
   */
  onRunnerReady(runnerId?: string): Promise<void> {
    const key = runnerId ?? "";
    let running = this.running.get(key);
    if (!running) {
      running = this.recover(runnerId).finally(() => this.running.delete(key));
      this.running.set(key, running);
    }
    return running;
  }

  private async recover(runnerId: string | undefined): Promise<void> {
    const { repo, sessions } = this.deps;
    const runner =
      runnerId && this.deps.runners ? this.deps.runners.forRunnerId(runnerId) : this.deps.runner;
    const onThisRunner = (id: string) => runnerForSession(this.deps, id) === runner;
    // Only sessions that were cut off before this runner was ready. A session started on it
    // meanwhile can turn `running` while `runner.status` is in flight (its first events can
    // arrive in the same read as the reply) and must not be mistaken for a cut-off one.
    const candidates = repo
      .list({ status: [...UNSETTLED] })
      .filter((s) => !sessions.launching.has(s.id) && onThisRunner(s.id))
      .map((s) => s.id);
    // Still unsettled: not being started, and no message, Retry or queued delivery on its way.
    const stillUnsettled = (id: string) => {
      const session = repo.find(id)?.session;
      return (
        !!session &&
        isUnsettled(session.status) &&
        !sessions.launching.has(id) &&
        !sessions.isDelivering(id)
      );
    };
    const hosted = await this.hostedSessions(runner);
    if (!hosted) return;
    const cut: Session[] = [];
    for (const id of candidates) {
      if (hosted.has(id) || !stillUnsettled(id)) continue;
      const before = repo.find(id)?.session;
      // Already cut off and waiting (an earlier restart, a usage limit): left as it is.
      if (!before || before.cutOff) continue;
      // Drained: the runner said it was going away. Otherwise it vanished mid-turn.
      const reason: CutOffReason = before.status === "interrupted" ? "app_closed" : "crash";
      const turnId = repo.rootTurnIds(before).at(-1) ?? null;
      // A runner that died without a word left its turns and approvals open: close them, so a
      // dead approval can't keep the session waiting once it is continued.
      repo.closeOrphanedTurns(id);
      const session = repo.find(id)?.session;
      if (!session || !isUnsettled(session.status)) continue;
      if (lastCompaction(repo, session)) {
        this.settleCompaction(session);
        continue;
      }
      if (!this.resumable(session, runner.providers())) continue;
      this.deps.log?.(`recovery: session ${id} was cut off (${reason}); it waits for Continue`);
      cut.push(this.deps.cutOffs.mark(id, reason, turnId));
    }
    this.deps.cutOffs.announce(cut, runnerId ?? "home");

    sessions.releaseOutboxes(onThisRunner);
    for (const id of sessions.sessionsWithQueuedMessages().filter(onThisRunner)) {
      await sessions.flushOutbox(id).catch(() => undefined);
    }

    // Sessions the queued messages above resumed are mid-turn again (and hosted): the sweep
    // leaves them alone.
    this.sweepAfterRecovery(runnerId ?? "", runner);
  }

  /**
   * Hide what a crash left in providers' own apps, without anyone waiting on it. One sweep per
   * runner at a time: a reconnect's sweep runs after the one in progress, with its own view of
   * which sessions to leave alone.
   */
  private sweepAfterRecovery(key: string, runner: RunnerPort): void {
    const sweepVendorHistory = this.deps.sweepVendorHistory;
    if (!sweepVendorHistory) return;
    const { sessions } = this.deps;
    const before = this.sweeping.get(key) ?? Promise.resolve();
    const sweep = before.then(async () => {
      const swept = await sweepVendorHistory(
        runner,
        (id) => sessions.launching.has(id) || sessions.isDelivering(id),
      ).catch(() => undefined);
      if (swept?.hidden.length || swept?.failed) {
        this.deps.log?.(
          `recovery: hid ${swept.hidden.length} conversations a restart left in a provider's app` +
            (swept.failed ? ` (${swept.failed} failed)` : ""),
        );
      }
    });
    this.sweeping.set(key, sweep);
    void sweep.finally(() => {
      if (this.sweeping.get(key) === sweep) this.sweeping.delete(key);
    });
  }

  /** The sessions the runner hosts right now; undefined (and logged) when it can't say. */
  private async hostedSessions(runner: RunnerPort): Promise<Set<string> | undefined> {
    try {
      const status = await runner.request({ name: "runner.status" }, 10_000);
      return new Set(status.sessions.map((s) => s.sessionId));
    } catch (error) {
      this.deps.log?.(`recovery: runner status failed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * The turn cut off was a compaction ("Compact now", or the factory's before a scout round):
   * there is no task to continue, and "continue where you left off" would re-run the finished
   * one before it. The session goes idle, as after a failed compaction; compacting again is up
   * to the user, and messages queued behind it (a round's brief) are delivered next.
   */
  private settleCompaction(session: Session): void {
    this.deps.log?.(`recovery: session ${session.id} was cut off while compacting; left idle`);
    this.deps.repo.update(session.id, (s) =>
      isUnsettled(s.status) ? { ...s, status: "idle" } : s,
    );
  }

  /**
   * Whether the session can be continued at all: through its provider's resume. One that can't
   * fails as before; there is nothing to wait for.
   */
  private resumable(session: Session, providers: ProviderInfo[]): boolean {
    const provider = providers.find((p) => p.id === session.provider);
    if (session.resumeToken && provider?.capabilities.resume) return true;
    this.deps.launcher.fail(
      session.id,
      "restart",
      new Error("The session was cut off by a restart and cannot be resumed"),
    );
    return false;
  }
}
