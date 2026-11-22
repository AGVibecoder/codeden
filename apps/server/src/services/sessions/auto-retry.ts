import {
  agentEventToNewEvent,
  type ErrorInfo,
  type RawEventEnvelope,
  type Session,
  type Settings,
  type UserInput,
} from "@codeden/contracts";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { rowToTurnRecord } from "../../db/rows";
import { turns } from "../../db/schema";
import { turnsNewestFirst } from "../../db/turn-order";
import { awaitsRetryDecision } from "../../events/reducer/retry";
import type { TurnRecord } from "../../events/reducer/types";
import type { EventStore } from "../../events/store";
import { errorMessage } from "../errors";
import type { InboxService } from "../inbox-service";
import type { SessionRepo } from "./repo";

/** Waits before the 1st, 2nd and 3rd automatic retry after a transient failure. */
export const RETRY_DELAYS_MS: readonly number[] = [20_000, 90_000, 5 * 60_000];

/** What to do about a session's failed root turn. */
export type RetryDecision =
  | { action: "retry"; turn: TurnRecord; error: ErrorInfo; attempt: number; at: number }
  | { action: "give_up"; turn: TurnRecord; error: ErrorInfo; attempt: number; exhausted: boolean }
  | { action: "none" };

export interface PlanOptions {
  enabled: boolean;
  delaysMs: readonly number[];
}

/**
 * Decide, from a session and its root turns (newest first), whether its last turn is retried
 * and when. Only an idle agent session whose last root turn, a work turn (never a compaction),
 * failed for a passing reason qualifies (`awaitsRetryDecision`); `attempt` counts the
 * consecutive such failures. A transient
 * failure waits `delaysMs[attempt - 1]` after the turn ended. Past the last delay, or switched
 * off: give up. Pure.
 */
export function planRetry(
  session: Session,
  rootTurns: readonly TurnRecord[],
  opts: PlanOptions,
): RetryDecision {
  const turn = rootTurns[0];
  if (!turn?.error || turn.status !== "failed" || session.status !== "idle") {
    return { action: "none" };
  }
  // A retry after a compaction would re-run the finished task before it.
  if (turn.kind === "compact") return { action: "none" };
  const error = turn.error;
  if (!awaitsRetryDecision(session, error)) return { action: "none" };
  let attempt = 0;
  for (const t of rootTurns) {
    if (t.kind === "compact" || t.status !== "failed" || !t.error) break;
    if (!awaitsRetryDecision(session, t.error)) break;
    attempt += 1;
  }
  const giveUp = (exhausted: boolean): RetryDecision => ({
    action: "give_up",
    turn,
    error,
    attempt,
    exhausted,
  });
  if (!opts.enabled) return giveUp(false);
  if (attempt > opts.delaysMs.length) return giveUp(true);
  const endedAt = Date.parse(turn.completedAt ?? turn.startedAt);
  const delay = opts.delaysMs[attempt - 1] ?? 0;
  return { action: "retry", turn, error, attempt, at: endedAt + delay };
}

/** "in 20s", "in 3 min", "in about 2 h 15 min". */
export function inAbout(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  return `in about ${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

export interface AutoRetryDeps {
  db: Db;
  store: EventStore;
  repo: SessionRepo;
  inbox: Pick<InboxService, "raiseRunFailed">;
  settings: () => Settings;
  /** The briefing a retry sends: the task, where it was, what it changed (`CutOffSessions`). */
  briefing: (session: Session, error: ErrorInfo) => Promise<string>;
  /** Send a message from CodeDen to an idle session. */
  send: (sessionId: string, input: UserInput) => Promise<unknown>;
  now?: () => number;
  delaysMs?: readonly number[];
  log?: (message: string) => void;
}

/**
 * Automatic retries for agent sessions (§7.3 `ErrorInfo.kind`). A root turn that failed for a
 * passing reason leaves the session idle with no inbox item (the reducer, `awaitsRetryDecision`);
 * this service then retries it with a `codeden` briefing (its task, where it was, what it
 * changed; never a bare "carry on") after a backoff of 20 s, 90 s and 5 min, at most three in a
 * row, and says so in the transcript. A usage limit doesn't come here: it cuts the session off
 * (§4.2). A user message or Stop cancels a pending retry. When the retries run out, or
 * `sessions.autoRetry` is off, the session fails as it always did: `failed` with a `run_failed`
 * inbox item (and the PM notices that come from it). Pending retries are derived from the turns
 * and sessions tables, so a server restart picks them up again. Orchestrator and PM sessions
 * are never retried here.
 */
export class AutoRetry {
  private readonly timers = new Map<string, { turnId: string; timer: NodeJS.Timeout }>();
  private unsubscribe: (() => void) | undefined;
  private stopped = false;

  constructor(private readonly deps: AutoRetryDeps) {}

  start(): void {
    this.stopped = false;
    this.unsubscribe = this.deps.store.subscribe((events) => this.onEvents(events));
    // Failures from before a restart: continue them or give up, as if they had just happened.
    setImmediate(() => {
      if (this.stopped) return;
      for (const session of this.deps.repo.list({ role: "agent", status: ["idle"] })) {
        this.evaluate(session.id);
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Sessions with a retry waiting (tests). */
  pending(): string[] {
    return [...this.timers.keys()];
  }

  private onEvents(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (!e.sessionId) continue;
      const sessionId = e.sessionId;
      if (e.type === "agent.turn.failed") {
        // Before other listeners' deferred work (a queued message sent to the idle session).
        queueMicrotask(() => this.evaluate(sessionId));
      } else if (e.type === "agent.turn.started" && this.timers.has(sessionId)) {
        this.cancel(sessionId, "A new message was sent, so the automatic retry was cancelled.");
      } else if (e.type === "session.updated" && this.timers.has(sessionId)) {
        const { session } = e.payload as { session: Session };
        if (session.status !== "idle" || session.archivedAt) {
          this.cancel(sessionId, "The automatic retry was cancelled.");
        }
      }
    }
  }

  /** Decide about a session's last root turn now: schedule, give up, or nothing. */
  evaluate(sessionId: string): void {
    try {
      const decision = this.decide(sessionId);
      if (decision.action === "retry") this.schedule(sessionId, decision);
      else if (decision.action === "give_up") this.giveUp(sessionId, decision);
    } catch (error) {
      this.deps.log?.(`auto-retry for ${sessionId}: ${errorMessage(error)}`);
    }
  }

  private decide(sessionId: string): RetryDecision {
    const session = this.deps.repo.find(sessionId)?.session;
    if (!session?.rootThreadId) return { action: "none" };
    const rootTurns = this.deps.db
      .select()
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.threadId, session.rootThreadId)))
      .orderBy(...turnsNewestFirst)
      .limit(10)
      .all()
      .map(rowToTurnRecord);
    return planRetry(session, rootTurns, {
      enabled: this.deps.settings().sessions.autoRetry,
      delaysMs: this.deps.delaysMs ?? RETRY_DELAYS_MS,
    });
  }

  private schedule(sessionId: string, plan: Extract<RetryDecision, { action: "retry" }>): void {
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing.timer);
    const wait = Math.max(0, plan.at - this.now());
    const max = (this.deps.delaysMs ?? RETRY_DELAYS_MS).length;
    this.notice(sessionId, plan.turn, {
      message: `Retrying automatically ${inAbout(wait)} (attempt ${plan.attempt} of ${max}).`,
      data: { attempt: plan.attempt, maxAttempts: max, retryAt: new Date(plan.at).toISOString() },
    });
    const timer = setTimeout(() => void this.fire(sessionId, plan.turn.id), wait);
    timer.unref?.();
    this.timers.set(sessionId, { turnId: plan.turn.id, timer });
  }

  private async fire(sessionId: string, turnId: string): Promise<void> {
    this.timers.delete(sessionId);
    if (this.stopped) return;
    let decision: RetryDecision;
    try {
      decision = this.decide(sessionId);
    } catch (error) {
      this.deps.log?.(`auto-retry for ${sessionId}: ${errorMessage(error)}`);
      return;
    }
    if (decision.action === "give_up") return this.giveUp(sessionId, decision);
    if (decision.action !== "retry" || decision.turn.id !== turnId) return;
    if (decision.at > this.now()) return this.schedule(sessionId, decision);
    this.deps.log?.(`auto-retry: retrying session ${sessionId} (attempt ${decision.attempt})`);
    try {
      const session = this.deps.repo.get(sessionId);
      const text = await this.deps.briefing(session, decision.error);
      await this.deps.send(sessionId, { text, attachments: [], from: "codeden" });
    } catch (error) {
      this.deps.log?.(`auto-retry for ${sessionId}: ${errorMessage(error)}`);
      this.giveUp(sessionId, { ...decision, action: "give_up", exhausted: false });
    }
  }

  /** Fail the session the usual way, with the `run_failed` item the reducer would have raised. */
  private giveUp(sessionId: string, decision: Extract<RetryDecision, { action: "give_up" }>): void {
    const pending = this.timers.get(sessionId);
    if (pending) clearTimeout(pending.timer);
    this.timers.delete(sessionId);
    if (decision.exhausted) {
      this.notice(sessionId, decision.turn, {
        message: `Stopped retrying after ${decision.attempt - 1} automatic ${decision.attempt === 2 ? "retry" : "retries"}.`,
        data: { attempt: decision.attempt },
      });
    }
    const session = this.deps.repo.update(sessionId, (s) =>
      s.status === "idle" ? { ...s, status: "failed" } : s,
    );
    if (session.status !== "failed") return;
    this.deps.inbox.raiseRunFailed(session, `${decision.turn.id}:failed`, decision.error.message);
  }

  private cancel(sessionId: string, message: string): void {
    const pending = this.timers.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.timers.delete(sessionId);
    const turn = this.deps.db
      .select()
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.id, pending.turnId)))
      .get();
    if (turn) this.notice(sessionId, rowToTurnRecord(turn), { message, data: { cancelled: true } });
  }

  /** The retry's notice in the failed turn, replaced as the retry's state changes. */
  private notice(
    sessionId: string,
    turn: TurnRecord,
    body: { message: string; data: Record<string, string | number | boolean> },
  ): void {
    this.deps.store.append([
      agentEventToNewEvent(sessionId, {
        type: "item.completed",
        threadId: turn.threadId,
        turnId: turn.id,
        item: {
          id: `auto-retry-${turn.id}`,
          kind: "notice",
          status: "completed",
          level: "info",
          code: "auto_retry",
          message: body.message,
          data: body.data,
        },
      }),
    ]);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
