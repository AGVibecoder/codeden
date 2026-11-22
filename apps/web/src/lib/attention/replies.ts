import type { Session, SessionStatus } from "@codeden/contracts";
import { speakerName } from "@/lib/voice/speaker";

/**
 * Alerts for replies (§11.1): when the orchestrator or a project manager finishes a turn, the
 * user gets a toast with the first line of what it said, and a desktop notification while
 * CodeDen is in the background. Workers (agent sessions) never raise one; their approvals,
 * questions and failures still come through the inbox.
 */

const MAX_LINE = 140;

/** A session went from working to at rest: its turn just finished. */
function turnFinished(prev: SessionStatus | undefined, next: SessionStatus): boolean {
  return (prev === "running" || prev === "waiting") && (next === "idle" || next === "completed");
}

/** Whether this status change of `session` raises a reply alert. */
export function raisesReplyAlert(
  session: Pick<Session, "role">,
  prev: SessionStatus | undefined,
  next: SessionStatus,
  ctx: {
    /** `notifications.replies`. */
    enabled: boolean;
    /** The user is looking at this session's chat right now (focused and on its page). */
    watching: boolean;
    /** A voice call with this session speaks its replies itself. */
    inCall: boolean;
  },
): boolean {
  if (session.role !== "orchestrator" && session.role !== "pm") return false;
  if (!ctx.enabled || ctx.watching || ctx.inCall) return false;
  return turnFinished(prev, next);
}

/** The alert's title: "Orchestrator replied", "Leonida project manager replied". */
export function replyTitle(
  session: Pick<Session, "role" | "title">,
  projectName: string | null,
): string {
  return `${speakerName(session, projectName)} replied`;
}

/** The first line of the reply that says something, without Markdown, shortened. */
export function replyLine(markdown: string | null): string | undefined {
  if (!markdown) return undefined;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw
      .replace(/\*\*|__|`/g, "")
      .replace(/^[\s#>*-]+/, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
  }
  return undefined;
}

/** Where the alert's Open goes: the project's PM page, or the orchestrator's chat. */
export function replyTarget(
  session: Pick<Session, "id" | "role" | "projectId">,
):
  | { to: "/projects/$projectId/pm"; params: { projectId: string } }
  | { to: "/sessions/$sessionId"; params: { sessionId: string } } {
  if (session.role === "pm" && session.projectId) {
    return { to: "/projects/$projectId/pm", params: { projectId: session.projectId } };
  }
  return { to: "/sessions/$sessionId", params: { sessionId: session.id } };
}

/** The page path of a session's chat, to tell whether the user is on it. */
export function replyPath(session: Pick<Session, "id" | "role" | "projectId">): string {
  return session.role === "pm" && session.projectId
    ? `/projects/${session.projectId}/pm`
    : `/sessions/${session.id}`;
}
