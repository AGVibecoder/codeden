import {
  type ContinueSessionRequest,
  type ContinueSessionResponse,
  type CutOffReason,
  canContinueAt,
  isCutOff,
  type RawEventEnvelope,
  type Session,
  type Settings,
} from "@codeden/contracts";
import type { EventStore } from "../../events/store";
import { badRequest, conflict, errorMessage } from "../errors";
import type { NoticeDraft } from "../orchestration/notices";
import { type RunnerDeps, runnerForSession, toServiceError } from "../runner-port";
import { type BriefingSources, gatherBriefing, renderBriefing } from "./cut-off-briefing";
import type { SessionRepo } from "./repo";
import type { SessionService } from "./session-service";

/** How long after a usage limit resets an opted-in session is continued. */
export const USAGE_RESET_MARGIN_MS = 60_000;
/** Longest single timer (setTimeout's limit); longer waits re-arm. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface CutOffDeps extends RunnerDeps {
  repo: SessionRepo;
  store: EventStore;
  sessions: Pick<SessionService, "continueWith">;
  /** Record an orchestrator notice and wake it (`OrchestrationService.notify`). */
  notify: (draft: NoticeDraft) => void;
  settings: () => Settings;
  checkpoints: BriefingSources["checkpoints"];
  now?: () => number;
  usageMarginMs?: number;
  log?: (message: string) => void;
}

/**
 * Cut-off sessions (§4.2): their turn stopped (a crash, CodeDen closed, a usage limit) and they
 * wait, red, for someone to continue them. Nothing continues them by itself, except at the
 * usage reset when the user opted in (on the session, or `sessions.continueWhenUsageResets`).
 * Continuing sends a briefing read from the log and the worktree (`cut-off-briefing.ts`).
 */
export class CutOffSessions {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: CutOffDeps) {}

  start(): void {
    this.unsubscribe = this.deps.store.subscribe((events) => this.onEvents(events));
    for (const s of this.deps.repo.list({ status: ["interrupted"] })) this.arm(s);
  }

  stop(): void {
    this.unsubscribe?.();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Sessions with a continue at the usage reset armed (tests). */
  armed(): string[] {
    return [...this.timers.keys()];
  }

  /** Every session that is cut off now, newest first. */
  list(): Session[] {
    return this.deps.repo.list({ status: ["interrupted"] }).filter(isCutOff);
  }

  /**
   * Mark a session cut off. Only for a session no runner runs any more (recovery asked its
   * runner): it waits for a Continue.
   */
  mark(sessionId: string, reason: CutOffReason, turnId: string | null): Session {
    const at = new Date(this.now()).toISOString();
    return this.deps.repo.update(sessionId, (s) => ({
      ...s,
      status: "interrupted",
      cutOff: { reason, at, turnId, resetsAt: null, continueWhenReset: false },
    }));
  }

  /**
   * Tell the orchestrator which workers (agent sessions) a runner's restart or crash cut off; it
   * tells the user. A cut-off PM or orchestrator resumes with its next wake.
   */
  announce(cut: Session[], key: string): void {
    const sessions = cut.filter((s) => s.role === "agent" && s.cutOff);
    if (sessions.length === 0) return;
    const n = sessions.length;
    this.deps.notify({
      id: `sessions.cut_off:${key}:${this.now()}`,
      type: "sessions.cut_off",
      projectId: null,
      target: "orchestrator",
      sessionId: null,
      title: `${n} ${n === 1 ? "worker was" : "workers were"} cut off last time`,
      data: {
        sessions: sessions.map((s) => ({
          sessionId: s.id,
          projectId: s.projectId,
          title: s.title ?? s.purpose,
          reason: s.cutOff?.reason ?? "crash",
        })),
      },
    });
  }

  /** Continue now, or opt in to / out of continuing at the usage reset. Throws `ServiceError`s. */
  async continue(sessionId: string, req: ContinueSessionRequest): Promise<ContinueSessionResponse> {
    const session = this.deps.repo.get(sessionId);
    const cutOff = session.cutOff;
    if (!cutOff || !isCutOff(session)) {
      throw conflict("This session isn't cut off", "not_cut_off");
    }
    if (req.mode !== "now") {
      if (cutOff.reason !== "usage_limit") {
        throw badRequest("Only a session stopped by a usage limit waits for a reset");
      }
      const on = req.mode === "when_usage_resets";
      const next = this.deps.repo.update(sessionId, (s) =>
        s.cutOff ? { ...s, cutOff: { ...s.cutOff, continueWhenReset: on } } : s,
      );
      this.arm(next);
      return { status: on ? "scheduled" : "cancelled" };
    }
    if (!canContinueAt(cutOff, this.now())) {
      throw conflict(`Usage resets at ${cutOff.resetsAt}`, "usage_not_reset");
    }
    await this.assertNotRunning(session);
    const text = await this.briefing(session, cutOff.reason, null);
    await this.deps.sessions.continueWith(sessionId, text);
    return { status: "continued" };
  }

  /** The briefing for a session, as CodeDen's message (also for automatic retries). */
  async briefing(session: Session, reason: CutOffReason, detail: string | null): Promise<string> {
    const runner = runnerForSession(this.deps, session.id);
    const briefing = await gatherBriefing(
      { repo: this.deps.repo, runner, checkpoints: this.deps.checkpoints },
      session,
      reason,
      detail,
    );
    return renderBriefing(briefing);
  }

  /**
   * Asked again at the moment of continuing: a runner still running this session's turn means
   * it was never cut off, and a second process must not start next to it.
   */
  private async assertNotRunning(session: Session): Promise<void> {
    const runner = runnerForSession(this.deps, session.id);
    const status = await runner
      .request({ name: "runner.status" }, 10_000)
      .catch((error: unknown) => {
        throw toServiceError(error);
      });
    const hosted = status.sessions.find((s) => s.sessionId === session.id);
    if (hosted?.state === "running") {
      throw conflict("The runner is still running this session's turn", "still_running");
    }
  }

  private onEvents(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (e.type === "session.updated") {
        this.arm((e.payload as { session: Session }).session);
      } else if (e.type === "settings.updated") {
        for (const s of this.deps.repo.list({ status: ["interrupted"] })) this.arm(s);
      }
    }
  }

  /** Arm (or disarm) the continue at the usage reset for a session, as its state says. */
  private arm(session: Session): void {
    const existing = this.timers.get(session.id);
    if (existing) clearTimeout(existing);
    this.timers.delete(session.id);
    const at = this.continuesAt(session);
    if (at === null) return;
    const timer = setTimeout(
      () => void this.fire(session.id),
      Math.min(Math.max(0, at - this.now()), MAX_TIMER_MS),
    );
    timer.unref?.();
    this.timers.set(session.id, timer);
  }

  /** When an opted-in usage-limit cut-off continues by itself; null when it doesn't. */
  private continuesAt(session: Session): number | null {
    const c = session.cutOff;
    if (!c || !isCutOff(session) || c.reason !== "usage_limit" || !c.resetsAt) return null;
    if (session.archivedAt) return null;
    if (!c.continueWhenReset && !this.deps.settings().sessions.continueWhenUsageResets) return null;
    return Date.parse(c.resetsAt) + (this.deps.usageMarginMs ?? USAGE_RESET_MARGIN_MS);
  }

  private async fire(sessionId: string): Promise<void> {
    this.timers.delete(sessionId);
    const session = this.deps.repo.find(sessionId)?.session;
    if (!session) return;
    const at = this.continuesAt(session);
    if (at === null) return;
    // A very long wait (a weekly limit) re-arms until it is due.
    if (at > this.now()) return this.arm(session);
    this.deps.log?.(`cut-off: continuing session ${sessionId} after the usage reset`);
    await this.continue(sessionId, { mode: "now" }).catch((error: unknown) => {
      this.deps.log?.(`cut-off: continuing ${sessionId} failed: ${errorMessage(error)}`);
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
