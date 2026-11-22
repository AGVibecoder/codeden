import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  GITHUB_MAX_FILE_BYTES,
  type PublishGithubPlan,
  type PublishGithubRequest,
  type PublishGithubResponse,
} from "@codeden/contracts";
import { conflict, ServiceError } from "../errors";
import type { Exec } from "../exec";
import type { GithubAuth } from "../github/auth";
import type { GithubClient } from "../github/client";
import { detectProject, isDirectory } from "./detect";
import type { ProjectService } from "./project-service";
import { slugify } from "./project-service";
import {
  coveredByLfs,
  detectTemplate,
  gitignoreFor,
  hasGitignore,
  templateRules,
} from "./publish-templates";

export interface PublishDeps {
  exec: Exec;
  projects: Pick<ProjectService, "get" | "refresh">;
  github: { auth: Pick<GithubAuth, "token" | "lastReason">; client: GithubClient };
}

/** Most files walked for the size estimate; beyond it the estimate stops counting. */
const MAX_WALK = 200_000;
const PUSH_TIMEOUT_MS = 60 * 60_000;

/**
 * Publish a local project to GitHub (§9): make the folder a git repository when it isn't one,
 * add a `.gitignore` and Git LFS patterns for the kind of project found (an Unreal project leaves
 * out `Binaries`, `Intermediate`, `Saved` and `DerivedDataCache`, and stores `.uasset` and
 * `.umap` files with LFS), make a first commit when there is none, create the repository on
 * GitHub, push, and turn the project into a GitHub project. `plan` says all of that first.
 */
export class GithubPublisher {
  constructor(private readonly deps: PublishDeps) {}

  async plan(projectId: string): Promise<PublishGithubPlan> {
    const project = this.deps.projects.get(projectId);
    const template = detectTemplate(project.path);
    const rules = templateRules(template);
    const detected = isDirectory(project.path)
      ? await detectProject(this.deps.exec, project.path)
      : null;
    const isGitRepo = Boolean(detected?.isGitRepo);
    const hasCommits = isGitRepo && (await this.git(project.path, ["rev-parse", "HEAD"])).ok;
    const lfsPatterns = hasCommits ? [] : rules.lfs;
    const walk = hasCommits ? null : walkFolder(project.path, rules.skipDirs, lfsPatterns);
    const owners = await this.owners().catch(() => []);
    let blocked: string | null = null;
    if (project.kind === "github") blocked = `${project.name} is already on GitHub.`;
    else if (!detected) blocked = `The project folder is missing: ${project.path}`;
    else if (detected.remoteUrl) {
      blocked = "This folder already has an origin remote; remove it or point it at GitHub.";
    } else if (owners.length === 0) {
      blocked =
        this.deps.github.auth.lastReason() ?? "GitHub isn't connected. Run `gh auth login`.";
    } else if (lfsPatterns.length && !(await this.git(project.path, ["lfs", "version"])).ok) {
      blocked = "This project needs Git LFS for its large files. Install Git LFS, then try again.";
    }
    return {
      isGitRepo,
      hasCommits,
      template,
      addsGitignore: Boolean(template) && !hasGitignore(project.path),
      lfsPatterns,
      files: walk?.files ?? null,
      bytes: walk?.bytes ?? null,
      tooLarge: walk?.tooLarge.slice(0, 50) ?? [],
      blocked,
      owners,
      suggestedName: slugify(project.name),
    };
  }

  async publish(projectId: string, req: PublishGithubRequest): Promise<PublishGithubResponse> {
    const plan = await this.plan(projectId);
    if (plan.blocked) throw conflict(plan.blocked, "cannot_publish");
    if (plan.tooLarge.length) {
      throw conflict(
        `GitHub refuses files over 100 MB: ${plan.tooLarge.slice(0, 5).join(", ")}`,
        "files_too_large",
      );
    }
    const token = await this.deps.github.auth.token();
    if (!token) throw conflict("GitHub isn't connected. Run `gh auth login`.", "not_connected");
    const dir = this.deps.projects.get(projectId).path;
    const login = plan.owners[0] as string;

    if (!plan.isGitRepo) await this.run(dir, ["init", "-b", "main"], "create the git repository");
    if (plan.addsGitignore && plan.template) {
      writeFileSync(join(dir, ".gitignore"), gitignoreFor(plan.template));
    }
    if (plan.lfsPatterns.length) {
      await this.run(dir, ["lfs", "install", "--local"], "set up Git LFS");
      await this.run(dir, ["lfs", "track", ...plan.lfsPatterns], "track large files with Git LFS");
    }
    if (!plan.hasCommits) {
      await this.run(dir, ["add", "-A"], "add the files");
      // The user's own git identity when set; else their GitHub account's no-reply address.
      const named = (await this.git(dir, ["config", "user.name"])).ok;
      const identity = named
        ? []
        : ["-c", `user.name=${login}`, "-c", `user.email=${login}@users.noreply.github.com`];
      await this.run(dir, [...identity, "commit", "-m", "Initial commit"], "make the first commit");
    }

    const repo = await this.deps.github.client.run(async (octokit) => {
      const body = { name: req.name, private: req.private, auto_init: false };
      const res =
        req.owner === login
          ? await octokit.request("POST /user/repos", body)
          : await octokit.request("POST /orgs/{org}/repos", { org: req.owner, ...body });
      return res.data as { html_url: string; clone_url: string };
    });
    await this.run(dir, ["remote", "add", "origin", repo.clone_url], "add the GitHub remote");
    // The token goes in an environment header, never on a command line.
    const basic = Buffer.from(`x-access-token:${token.value}`).toString("base64");
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    };
    await this.run(dir, ["push", "-u", "origin", "HEAD"], "push to GitHub", {
      env,
      timeoutMs: PUSH_TIMEOUT_MS,
    });
    const { project } = await this.deps.projects.refresh(projectId);
    return { project, url: repo.html_url };
  }

  /** The signed-in account, then the organizations it belongs to. */
  private async owners(): Promise<string[]> {
    return this.deps.github.client.run(async (octokit) => {
      const user = (await octokit.request("GET /user")).data as { login: string };
      const orgs = (await octokit.request("GET /user/orgs", { per_page: 100 })).data as Array<{
        login: string;
      }>;
      return [user.login, ...orgs.map((o) => o.login)];
    });
  }

  private async git(dir: string, args: string[]): Promise<{ ok: boolean; out: string }> {
    const r = await this.deps.exec("git", args, { cwd: dir, timeoutMs: 30_000 });
    return { ok: r.code === 0, out: `${r.stdout}${r.stderr}`.trim() };
  }

  private async run(
    dir: string,
    args: string[],
    what: string,
    opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  ): Promise<void> {
    const r = await this.deps.exec("git", args, {
      cwd: dir,
      timeoutMs: opts.timeoutMs ?? 10 * 60_000,
      ...(opts.env ? { env: opts.env } : {}),
    });
    if (r.code !== 0) {
      const detail = `${r.stderr || r.stdout}`.trim().split(/\r?\n/).slice(-3).join(" ");
      throw new ServiceError(502, "publish_failed", `Couldn't ${what}: ${detail || "git failed"}`);
    }
  }
}

/** Files a first commit would take (folders the template leaves out skipped), and big ones. */
function walkFolder(
  root: string,
  skipDirs: readonly string[],
  lfs: readonly string[],
): { files: number; bytes: number; tooLarge: string[] } {
  const skip = new Set([".git", ...skipDirs]);
  let files = 0;
  let bytes = 0;
  const tooLarge: string[] = [];
  const stack = [root];
  while (stack.length && files < MAX_WALK) {
    const dir = stack.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        // `.git` and the folders the template's `.gitignore` leaves out, wherever they are.
        if (skip.has(e.name)) continue;
        stack.push(path);
      } else if (e.isFile()) {
        let size = 0;
        try {
          size = statSync(path).size;
        } catch {
          continue;
        }
        files++;
        bytes += size;
        if (size > GITHUB_MAX_FILE_BYTES && !coveredByLfs(e.name, lfs)) {
          tooLarge.push(relative(root, path));
        }
      }
    }
  }
  return { files, bytes, tooLarge };
}
