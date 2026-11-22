import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import type {
  Project,
  RemoveProjectRequest,
  RemoveProjectResponse,
  Session,
  SessionStatus,
} from "@codeden/contracts";
import { badRequest } from "../errors";

/** Sessions with a provider process that may still work in the project's folder. */
const LIVE: ReadonlySet<SessionStatus> = new Set([
  "created",
  "queued",
  "starting",
  "running",
  "waiting",
  "idle",
]);

export interface ProjectRemoverDeps {
  projects: {
    get(id: string): Project;
    list(): Project[];
    archive(id: string): void;
  };
  sessions: { list(query: { projectId: string }): Session[] };
  stopSession: (id: string) => Promise<unknown>;
  /** Archive an agent session and remove its worktree (`WorktreeCleanup.archive`). */
  archiveSession: (id: string, opts: { force: boolean }) => Promise<unknown>;
  /** CodeDen's data folder: never deleted, nor any folder that holds it. */
  codedenHome: string;
  /** The user's home folder (default `os.homedir()`). */
  userHome?: string;
  /** Delete a folder (default `fs.rm`, recursive). Overridable for tests. */
  removeFolder?: (path: string) => Promise<void>;
}

const key = (path: string) => {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
};

/** `inner` is `outer` or inside it. */
function within(inner: string, outer: string): boolean {
  const rel = relative(key(outer), key(inner));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Why deleting `folder` is refused, or null when it may go: a drive root, the user's home or
 * a folder holding it, CodeDen's data folder or a folder holding it, or a folder that holds
 * another active project or lies inside one.
 */
export function folderDeleteProblem(
  folder: string,
  ctx: { userHome: string; codedenHome: string; otherProjects: string[] },
): string | null {
  const path = resolve(folder);
  if (parse(path).root === path || dirname(path) === path) return `${path} is a drive root`;
  if (within(ctx.userHome, path)) return `${path} is your home folder or holds it`;
  if (within(ctx.codedenHome, path)) return `${path} holds CodeDen's own data`;
  const nested = ctx.otherProjects.find((other) => within(other, path));
  if (nested) return `${path} holds another project (${nested})`;
  const outer = ctx.otherProjects.find((other) => within(path, other));
  if (outer) return `${path} is inside another project (${outer})`;
  return null;
}

/**
 * Take a project out of CodeDen (§9): stop its sessions, archive its agent sessions and remove
 * their worktrees, archive the project, and with `deleteFolder` delete its folder from disk.
 * The folder is checked first, so nothing is stopped or archived for a folder that can't go.
 */
export class ProjectRemover {
  constructor(private readonly deps: ProjectRemoverDeps) {}

  async remove(id: string, req: RemoveProjectRequest): Promise<RemoveProjectResponse> {
    const project = this.deps.projects.get(id);
    if (project.archivedAt) throw badRequest("The project was already removed", "project_archived");
    if (req.deleteFolder) {
      const problem = folderDeleteProblem(project.path, {
        userHome: this.deps.userHome ?? homedir(),
        codedenHome: this.deps.codedenHome,
        otherProjects: this.deps.projects
          .list()
          .filter((p) => p.id !== id)
          .map((p) => p.path),
      });
      if (problem) throw badRequest(`Can't delete the folder: ${problem}`, "folder_protected");
    }
    const sessions = this.deps.sessions.list({ projectId: id });
    for (const session of sessions) {
      if (LIVE.has(session.status)) await this.deps.stopSession(session.id);
    }
    for (const session of sessions) {
      if (session.role === "agent" && !session.archivedAt) {
        await this.deps.archiveSession(session.id, { force: req.deleteFolder });
      }
    }
    this.deps.projects.archive(id);
    if (req.deleteFolder) {
      await (this.deps.removeFolder ?? removeFolder)(project.path);
    }
    return { path: project.path, deletedFolder: req.deleteFolder, sessions: sessions.length };
  }
}

/** Delete a folder and everything in it, retrying briefly while a just-stopped process lets go. */
function removeFolder(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
