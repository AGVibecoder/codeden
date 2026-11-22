import { z } from "zod";
import { Id, Timestamp } from "./common";

/**
 * Why a session's work stopped mid-turn (§4.2 *Cut-off sessions*):
 * - `crash`: the runner went away without a word while the turn ran (a crash or a kill).
 * - `app_closed`: CodeDen was closed or restarted (the runner drained) while the turn ran.
 * - `usage_limit`: the provider's usage limit ended the turn.
 * - `error`: a passing provider error (an overloaded API, a dropped connection) ended it; only
 *   automatic retries brief for it, it never leaves a session cut off.
 */
export const CutOffReason = z.enum(["crash", "app_closed", "usage_limit", "error"]);
export type CutOffReason = z.infer<typeof CutOffReason>;

/**
 * A session whose turn was cut off and that waits for someone to continue it (§4.2). Set only
 * once CodeDen knows no runner still runs that turn (recovery asked the runner), or by the
 * usage limit that ended it. Nothing continues it by itself, except at the usage reset when
 * the user opted in. The next turn clears it.
 */
export const SessionCutOff = z.object({
  reason: CutOffReason,
  /** When CodeDen marked it cut off. */
  at: Timestamp,
  /** The root turn that was cut off; null when none was recorded. */
  turnId: Id.nullable(),
  /** `usage_limit`: when the provider said usage resets; null when it didn't say. */
  resetsAt: Timestamp.nullable(),
  /** `usage_limit`: continue with a briefing by itself once usage resets (the user's choice). */
  continueWhenReset: z.boolean(),
});
export type SessionCutOff = z.infer<typeof SessionCutOff>;

/** Whether a session is cut off and waiting to be continued. */
export function isCutOff(s: { status: string; cutOff?: SessionCutOff | null }): boolean {
  return s.status === "interrupted" && !!s.cutOff;
}

/** Whether a cut-off session may be continued now: a usage limit must have reset first. */
export function canContinueAt(cutOff: SessionCutOff, now: number): boolean {
  if (cutOff.reason !== "usage_limit" || !cutOff.resetsAt) return true;
  return Date.parse(cutOff.resetsAt) <= now;
}

/** The last thing a cut-off session was doing, from its transcript. */
export const BriefingActivity = z.object({
  kind: z.enum(["command", "tool", "message"]),
  /** The command line, the tool's title, or the start of the message. */
  title: z.string(),
  /** Whether it had finished when the turn was cut off. */
  finished: z.boolean(),
  /** The tail of its output so far (commands), clipped; null when there was none. */
  output: z.string().nullable(),
});
export type BriefingActivity = z.infer<typeof BriefingActivity>;

/** What the session changed since its last checkpoint, size-capped. */
export const BriefingChanges = z.object({
  /** `checkpoint`: since the last checkpoint CodeDen took; `head`: uncommitted, without one. */
  since: z.enum(["checkpoint", "head"]),
  /** Changed files, as `git diff --stat` would name them. */
  files: z.array(z.string()),
  /** The unified diff, clipped to the cap. */
  diff: z.string(),
  truncated: z.boolean(),
});
export type BriefingChanges = z.infer<typeof BriefingChanges>;

/**
 * What a continued session is told (§4.2), read from the event log and the worktree, never
 * guessed: the task as it was given, where the work was, why it stopped and what it already
 * changed. Rendered as CodeDen's message; it ends by asking the agent to check where things
 * stand before picking up, never to re-run its last step blindly.
 */
export const ContinueBriefing = z.object({
  /** The session's first message (its instructions), clipped; the purpose without one. */
  task: z.string(),
  /** Later messages from people and roles (not CodeDen's own), newest last, clipped. */
  laterRequests: z.array(z.string()),
  reason: CutOffReason,
  /** The error's message when there was one (usage limit, passing error). */
  detail: z.string().nullable(),
  lastActivity: BriefingActivity.nullable(),
  /** Null when there were no changes; `unavailable` says why they couldn't be read. */
  changes: BriefingChanges.nullable(),
  unavailable: z.string().nullable(),
  /**
   * The work may carry text from people outside the project (an issue, or started by the
   * factory, an automation or a PM): the briefing keeps the untrusted-input rule.
   */
  quotesUntrusted: z.boolean(),
});
export type ContinueBriefing = z.infer<typeof ContinueBriefing>;

/**
 * `POST /api/sessions/:id/continue`: continue a cut-off session with its briefing (`now`), or
 * opt in to (`when_usage_resets`) or out of (`cancel`) continuing by itself at the usage reset.
 */
export const ContinueSessionRequest = z.object({
  mode: z.enum(["now", "when_usage_resets", "cancel"]).default("now"),
});
export type ContinueSessionRequest = z.infer<typeof ContinueSessionRequest>;
export type ContinueSessionRequestInit = z.input<typeof ContinueSessionRequest>;

export const ContinueSessionResponse = z.object({
  status: z.enum(["continued", "scheduled", "cancelled"]),
});
export type ContinueSessionResponse = z.infer<typeof ContinueSessionResponse>;
