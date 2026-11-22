import type { SessionStatus } from "@codeden/contracts";
import { type RunnerDeps, runnerForSession } from "../runner-port";
import type { SessionRepo } from "./repo";

/** Sessions the runner may be hosting right now. */
const OPEN: SessionStatus[] = ["starting", "running", "waiting", "idle", "interrupted"];

const LIVE_TIMEOUT_MS = 10_000;

/**
 * Send the folders agents may write to (`settings.autonomy.writableFolders`) to every open
 * session on the home runner, so a folder added in Settings applies from their next tool call
 * instead of their next start. Sessions on other runners never get them (`launcher.ts`). A
 * session the runner no longer hosts, or one it can't reach, gets them at its next start anyway.
 * Returns how many sessions took them.
 */
export async function pushWritableFolders(
  deps: RunnerDeps & { repo: SessionRepo; log?: (message: string) => void },
  folders: string[],
): Promise<number> {
  const sessions = deps.repo
    .list({ status: OPEN })
    .filter((s) => runnerForSession(deps, s.id) === deps.runner);
  const results = await Promise.allSettled(
    sessions.map((s) =>
      deps.runner.request(
        { name: "session.configure", sessionId: s.id, writableFolders: folders },
        LIVE_TIMEOUT_MS,
      ),
    ),
  );
  const taken = results.filter((r) => r.status === "fulfilled").length;
  if (sessions.length > 0) {
    deps.log?.(`writable folders sent to ${taken} of ${sessions.length} open sessions`);
  }
  return taken;
}
