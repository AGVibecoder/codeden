import type { ErrorInfo, Session } from "@codeden/contracts";

/**
 * Whether a failed root turn is left for automatic retry to decide (`AutoRetry`): an agent
 * session's turn that failed for a passing reason (`transient`). The reducer leaves such a
 * session idle with no inbox item; the auto-retry service then either schedules the retry or
 * fails the session the usual way. A usage limit cuts the session off instead (§4.2).
 * Orchestrator and PM sessions, and every other failure, fail at once. Pure.
 */
export function awaitsRetryDecision(session: Session, error: ErrorInfo): boolean {
  return session.role === "agent" && error.kind === "transient";
}
