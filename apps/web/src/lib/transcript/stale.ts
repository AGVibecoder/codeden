import type { SessionStatus } from "@codeden/contracts";
import type { TranscriptState } from "./reducer";

/** Session statuses in which no turn can be running. */
const AT_REST: ReadonlySet<SessionStatus> = new Set([
  "idle",
  "interrupted",
  "completed",
  "failed",
  "stopped",
]);

/**
 * The root turn a loaded transcript still shows running although the session is at rest
 * (§6): the transcript missed the turn's end, so the view would say "Working" forever. Null
 * when the two agree. The session status comes from the global stream, which keeps it current
 * on its own.
 */
export function staleRunningTurn(
  transcript: TranscriptState | undefined,
  status: SessionStatus | undefined,
): string | null {
  if (!transcript || !status || !AT_REST.has(status)) return null;
  const root = transcript.rootThreadId ? transcript.threads[transcript.rootThreadId] : undefined;
  for (const id of root?.turnIds ?? []) {
    if (transcript.turns[id]?.status === "running") return id;
  }
  return null;
}
