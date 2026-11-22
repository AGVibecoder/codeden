import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, Session } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { folderDeleteProblem, ProjectRemover } from "../src/services/projects/remove";

/**
 * Removing a project (§9): its sessions stop, agent sessions are archived, the project is
 * archived and its folder deleted; folders that must never go are refused before anything runs.
 */
let dir: string;
let folder: string;
let stopped: string[];
let archivedSessions: Array<{ id: string; force: boolean }>;
let archivedProjects: string[];
let others: Project[];

const project = (over: Partial<Project> = {}) =>
  ({
    id: "p1",
    name: "tradingbots",
    path: folder,
    kind: "local",
    archivedAt: null,
    ...over,
  }) as Project;
const session = (id: string, status: Session["status"], role: Session["role"] = "agent") =>
  ({ id, status, role, archivedAt: null }) as Session;

const remover = (p: Project = project()) =>
  new ProjectRemover({
    projects: {
      get: () => p,
      list: () => [p, ...others],
      archive: (id) => archivedProjects.push(id),
    },
    sessions: {
      list: () => [
        session("pm", "idle", "pm"),
        session("a1", "running"),
        session("a2", "completed"),
      ],
    },
    stopSession: async (id) => stopped.push(id),
    archiveSession: async (id, o) => archivedSessions.push({ id, force: o.force }),
    codedenHome: join(dir, "codeden-home"),
    userHome: join(dir, "home"),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-remove-"));
  folder = join(dir, "PROJECTS", "tradingbots");
  mkdirSync(join(folder, "src"), { recursive: true });
  writeFileSync(join(folder, "src", "bot.py"), "print('hi')");
  stopped = [];
  archivedSessions = [];
  archivedProjects = [];
  others = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("removing a project", () => {
  it("stops its live sessions, archives them and the project, and deletes the folder", async () => {
    const res = await remover().remove("p1", { deleteFolder: true });
    expect(res).toEqual({ path: folder, deletedFolder: true, sessions: 3 });
    expect(stopped).toEqual(["pm", "a1"]);
    expect(archivedSessions).toEqual([
      { id: "a1", force: true },
      { id: "a2", force: true },
    ]);
    expect(archivedProjects).toEqual(["p1"]);
    expect(existsSync(folder)).toBe(false);
  });

  it("keeps the folder when only removing it from CodeDen", async () => {
    await remover().remove("p1", { deleteFolder: false });
    expect(archivedProjects).toEqual(["p1"]);
    expect(existsSync(join(folder, "src", "bot.py"))).toBe(true);
  });

  it("refuses a folder that holds another project, before stopping anything", async () => {
    others = [project({ id: "p2", path: join(folder, "sub") })];
    await expect(remover().remove("p1", { deleteFolder: true })).rejects.toThrow(
      "holds another project",
    );
    expect(stopped).toEqual([]);
    expect(archivedProjects).toEqual([]);
    expect(existsSync(folder)).toBe(true);
  });

  it("never deletes a drive root, the home folder or CodeDen's data", () => {
    const ctx = {
      userHome: join(dir, "home", "me"),
      codedenHome: join(dir, "data", "codeden"),
      otherProjects: [join(dir, "PROJECTS", "other")],
    };
    expect(folderDeleteProblem(process.platform === "win32" ? "E:\\" : "/", ctx)).toContain(
      "drive root",
    );
    expect(folderDeleteProblem(join(dir, "home"), ctx)).toContain("home folder");
    expect(folderDeleteProblem(join(dir, "home", "me"), ctx)).toContain("home folder");
    expect(folderDeleteProblem(join(dir, "data"), ctx)).toContain("CodeDen's own data");
    expect(folderDeleteProblem(join(dir, "PROJECTS"), ctx)).toContain("holds another project");
    expect(folderDeleteProblem(join(dir, "PROJECTS", "other", "x"), ctx)).toContain(
      "inside another project",
    );
    expect(folderDeleteProblem(join(dir, "PROJECTS", "tradingbots"), ctx)).toBeNull();
  });

  it("refuses a project that was already removed", async () => {
    await expect(
      remover(project({ archivedAt: "2026-11-22T12:00:00.000Z" })).remove("p1", {
        deleteFolder: true,
      }),
    ).rejects.toThrow("already removed");
  });
});
