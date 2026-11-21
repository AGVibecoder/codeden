import { readFileSync } from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { claudeMemoryDir } from "@codeden/providers";
import { isInside } from "../files/path-guard";

export { claudeProjectSlug, findGitRoot, mainRepoRoot } from "@codeden/providers";

/**
 * The project's Claude auto-memory folder (§12.4): `autoMemoryDirectory` from the user's
 * `~/.claude/settings.json` when set, else `~/.claude/projects/<slug>/memory`. The slug comes
 * from the git repository root, so every worktree of a repo shares one folder.
 */
export function claudeAutoMemoryDir(home: string, repoRoot: string): string {
  return claudeMemoryDir(join(home, ".claude"), repoRoot, home);
}

/** The user's own config folders in the home folder, which may be links (to another drive). */
const HOME_CONFIG_DIRS = [".claude", ".codex"];

/**
 * The folder a home-level config file must stay inside, links included: its `~/.claude` or
 * `~/.codex` folder when it is in one, else the home folder. That folder itself may be a link
 * the user made (such as to another drive); links inside it must still stay inside it.
 */
export function homeGuardRoot(home: string, file: string): string {
  const target = resolve(home, file);
  for (const name of HOME_CONFIG_DIRS) {
    const dir = join(home, name);
    if (isInside(resolve(dir), target)) return dir;
  }
  return home;
}

/** `dir` and its ancestors, nearest first, up to the filesystem root. */
export function ancestors(dir: string): string[] {
  const out: string[] = [];
  let current = resolve(dir);
  for (;;) {
    out.push(current);
    const parent = dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

/** Directories from `root` down to `cwd` (inclusive); just `[cwd]` when cwd is not inside. */
export function dirsFromRootTo(root: string, cwd: string): string[] {
  const rel = relative(root, cwd);
  if (rel.startsWith("..") || parse(rel).root) return [resolve(cwd)];
  const parts = rel ? rel.split(sep) : [];
  return [resolve(root), ...parts.map((_, i) => join(root, ...parts.slice(0, i + 1)))];
}

/** `/`-separated path of `path` relative to `root`. */
export function toRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

export function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** `name` and `description` from a markdown file's YAML front matter (simple keys only). */
export function frontMatter(file: string): { name?: string; description?: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8").slice(0, 8_000);
  } catch {
    return {};
  }
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!block) return {};
  const out: { name?: string; description?: string } = {};
  for (const key of ["name", "description"] as const) {
    const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(block);
    const value = m?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (value && value !== ">" && value !== "|") out[key] = value;
  }
  return out;
}
