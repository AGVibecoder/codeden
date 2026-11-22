import type { SessionStatus, Snapshot } from "@codeden/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { CodeDenClient } from "@/lib/api";
import { platform } from "@/lib/platform";
import { snapshotKey } from "@/lib/queries";
import { onLiveEvent } from "@/lib/realtime";
import { transcriptFromSnapshot } from "@/lib/transcript/reducer";
import { finalAssistantText } from "@/lib/transcript/timeline";
import { latestCompletedRootTurn } from "@/lib/voice/read-aloud";
import { inCallWith } from "@/stores/call";
import { raisesReplyAlert, replyLine, replyPath, replyTarget, replyTitle } from "./replies";
import { UPDATE_TOAST_MS } from "./updates";

/**
 * Raise reply alerts (`replies.ts`) from live session updates: a toast with Open, and a desktop
 * notification while CodeDen is in the background. Returns a stop.
 */
export function startReplyAlerts(deps: {
  client: CodeDenClient;
  queryClient: QueryClient;
  /** The current page path, to skip a reply the user is already looking at. */
  currentPath: () => string;
  open: (target: ReturnType<typeof replyTarget>) => void;
}): () => void {
  const statuses = new Map<string, SessionStatus>();
  const snapshot = () => deps.queryClient.getQueryData<Snapshot>(snapshotKey);
  for (const s of snapshot()?.sessions ?? []) statuses.set(s.id, s.status);

  return onLiveEvent((env) => {
    if (env.type !== "session.created" && env.type !== "session.updated") return;
    const session = env.payload.session;
    const prev = statuses.get(session.id);
    statuses.set(session.id, session.status);
    const snap = snapshot();
    if (!snap) return;
    const notifications = snap.settings.notifications;
    const focused = platform.isFocused();
    const alert = raisesReplyAlert(session, prev, session.status, {
      enabled: notifications.replies,
      watching: focused && deps.currentPath() === replyPath(session),
      inCall: inCallWith(session),
    });
    if (!alert) return;
    const project = snap.projects.find((p) => p.id === session.projectId)?.name ?? null;
    const title = replyTitle(session, project);
    const target = replyTarget(session);
    const open = () => deps.open(target);
    void deps.client
      .getSessionSnapshot(session.id, { turns: 2 })
      .then((s) => {
        const state = transcriptFromSnapshot(s);
        const turnId = latestCompletedRootTurn(state);
        return turnId ? finalAssistantText(state, turnId) : null;
      })
      .catch(() => null)
      .then((text) => {
        const description = replyLine(text);
        if (notifications.toasts) {
          toast(title, {
            id: `reply:${session.id}`,
            description,
            duration: UPDATE_TOAST_MS,
            action: { label: "Open", onClick: open },
          });
        }
        if (notifications.browser && !platform.isFocused()) {
          platform.notify(title, { body: description, tag: `reply:${session.id}`, onClick: open });
        }
      });
  });
}
