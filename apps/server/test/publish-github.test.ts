import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Exec, ExecResult } from "../src/services/exec";
import type { GithubClient } from "../src/services/github/client";
import { GithubPublisher } from "../src/services/projects/publish";
import { coveredByLfs, detectTemplate } from "../src/services/projects/publish-templates";

/**
 * Publishing a local project to GitHub (§9): the plan says what will happen, and publishing
 * makes the repository, the first commit and the push, with the token never on a command line.
 */
let dir: string;
let git: Array<{ args: string[]; env?: NodeJS.ProcessEnv }>;
let created: Array<{ route: string; body: Record<string, unknown> }>;
let isRepo: boolean;

const ok = (stdout = ""): ExecResult =>
  ({ code: 0, stdout, stderr: "", notFound: false, timedOut: false }) as unknown as ExecResult;
const fail = (): ExecResult =>
  ({
    code: 1,
    stdout: "",
    stderr: "fatal",
    notFound: false,
    timedOut: false,
  }) as unknown as ExecResult;

const exec: Exec = async (_cmd, args, opts) => {
  git.push({ args, ...(opts?.env ? { env: opts.env } : {}) });
  if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return isRepo ? ok(dir) : fail();
  if (args[0] === "rev-parse") return isRepo ? ok("abc") : fail();
  if (args[0] === "init") isRepo = true;
  if (args[0] === "config") return fail();
  return ok();
};

const client = {
  run: async <T>(fn: (o: unknown) => Promise<T>) =>
    fn({
      request: async (route: string, body: Record<string, unknown> = {}) => {
        if (route === "GET /user") return { data: { login: "gino" } };
        if (route === "GET /user/orgs") return { data: [{ login: "Group-AG" }] };
        created.push({ route, body });
        return {
          data: {
            html_url: `https://github.com/gino/${body.name}`,
            clone_url: `https://github.com/gino/${body.name}.git`,
          },
        };
      },
    }),
} as unknown as GithubClient;

let project: Project;
const publisher = () =>
  new GithubPublisher({
    exec,
    projects: {
      get: () => project,
      refresh: async () => ({
        project: { ...project, kind: "github" } as Project,
        outcome: "github_connected" as const,
        changed: true,
        message: "",
        detected: null,
      }),
    },
    github: {
      auth: { token: async () => ({ value: "gho_secret", source: "gh" }), lastReason: () => null },
      client,
    },
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-publish-"));
  git = [];
  created = [];
  isRepo = false;
  writeFileSync(join(dir, "HordesOfDeath2.uproject"), "{}");
  mkdirSync(join(dir, "Content"));
  writeFileSync(join(dir, "Content", "Map.umap"), "x".repeat(10));
  mkdirSync(join(dir, "Intermediate"));
  writeFileSync(join(dir, "Intermediate", "big.obj"), "x".repeat(1000));
  project = { id: "p1", name: "HordesOfDeath2", path: dir, kind: "local" } as Project;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("publishing a local project to GitHub", () => {
  it("knows an Unreal project and which large files Git LFS covers", () => {
    expect(detectTemplate(dir)).toBe("unreal");
    expect(coveredByLfs("Hero.UASSET", ["*.uasset"])).toBe(true);
    expect(coveredByLfs("movie.mov", ["*.uasset"])).toBe(false);
  });

  it("plans a repository, an Unreal .gitignore, Git LFS and a first commit without Intermediate", async () => {
    const plan = await publisher().plan("p1");
    expect(plan).toMatchObject({
      isGitRepo: false,
      hasCommits: false,
      template: "unreal",
      addsGitignore: true,
      files: 2,
      bytes: 12,
      tooLarge: [],
      blocked: null,
      owners: ["gino", "Group-AG"],
      suggestedName: "hordesofdeath2",
    });
    expect(plan.lfsPatterns).toContain("*.uasset");
    // Planning changes nothing.
    expect(git.some((c) => c.args[0] === "init")).toBe(false);
  });

  it("creates the repo, commits, and pushes with the token only in the environment", async () => {
    const result = await publisher().publish("p1", {
      owner: "gino",
      name: "hordes-of-death-2",
      private: true,
    });
    expect(result.url).toBe("https://github.com/gino/hordes-of-death-2");
    expect(created).toEqual([
      {
        route: "POST /user/repos",
        body: { name: "hordes-of-death-2", private: true, auto_init: false },
      },
    ]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("Intermediate/");
    const order = git.map((c) => c.args.filter((a) => !a.startsWith("user.") && a !== "-c")[0]);
    expect(order).toEqual(
      expect.arrayContaining(["init", "lfs", "add", "commit", "remote", "push"]),
    );
    const push = git.find((c) => c.args[0] === "push");
    expect(push?.args.join(" ")).not.toContain("gho_secret");
    expect(push?.env?.GIT_CONFIG_VALUE_0).toContain(
      Buffer.from("x-access-token:gho_secret").toString("base64"),
    );
  });

  it("creates an organization's repository under the organization", async () => {
    await publisher().publish("p1", { owner: "Group-AG", name: "game", private: false });
    expect(created[0]).toEqual({
      route: "POST /orgs/{org}/repos",
      body: { org: "Group-AG", name: "game", private: false, auto_init: false },
    });
  });

  it("refuses a project that is already on GitHub", async () => {
    project = { ...project, kind: "github" } as Project;
    expect((await publisher().plan("p1")).blocked).toContain("already on GitHub");
    await expect(
      publisher().publish("p1", { owner: "gino", name: "x", private: true }),
    ).rejects.toThrow("already on GitHub");
  });
});
