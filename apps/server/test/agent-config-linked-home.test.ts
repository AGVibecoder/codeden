import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentConfigLocator } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentConfigFiles } from "../src/services/agent-config/files";
import { claudeHookFile } from "../src/services/agent-config/hooks";
import { guard } from "../src/services/agent-config/hooks-service";
import { ServiceError } from "../src/services/errors";
import { removeTree } from "./support/remove-tree";

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const errorCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof ServiceError ? `${error.status} ${error.code}` : String(error);
  }
  return "no error";
};

/**
 * The user's own `~/.claude` and `~/.codex` folders may be links (moved to another drive), so
 * the files in them are used; a link inside them, or in a project, must still stay inside.
 */
describe("agent config in linked home folders", () => {
  let dir: string;
  let home: string;
  let repo: string;
  let files: AgentConfigFiles;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-linked-"));
    home = join(dir, "home");
    repo = join(dir, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    files = new AgentConfigFiles(
      (l: AgentConfigLocator) => (l.root === "home" ? home : repo),
      join(dir, "backups"),
    );
  });
  afterEach(() => removeTree(dir));

  const link = (target: string, at: string) => {
    mkdirSync(target, { recursive: true });
    rmSync(at, { recursive: true, force: true });
    symlinkSync(target, at, "junction");
  };

  it("reads memory and settings in a ~/.claude or ~/.codex folder that is a link", () => {
    const claude = join(dir, "other-drive", ".claude");
    const codex = join(dir, "other-drive", ".codex");
    put(join(claude, "CLAUDE.md"), "# user memory\n");
    put(join(codex, "AGENTS.md"), "codex user\n");
    link(claude, join(home, ".claude"));
    link(codex, join(home, ".codex"));
    expect(files.read({ root: "home", path: ".claude/CLAUDE.md" }).content).toBe("# user memory\n");
    expect(files.read({ root: "home", path: ".codex/AGENTS.md" }).content).toBe("codex user\n");
    expect(errorCode(() => guard(claudeHookFile("user", home, null)))).toBe("no error");
  });

  it("still refuses a link inside ~/.claude that leads out of it", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const elsewhere = join(dir, "elsewhere");
    put(join(elsewhere, "x.md"), "secret\n");
    link(elsewhere, join(home, ".claude", "agents"));
    expect(errorCode(() => files.resolve({ root: "home", path: ".claude/agents/x.md" }))).toBe(
      "403 path_outside_root",
    );
  });

  it("still refuses a project's .claude folder that links out of the project", () => {
    const elsewhere = join(dir, "elsewhere");
    link(elsewhere, join(repo, ".claude"));
    const file = claudeHookFile("project", home, { id: "p1", path: repo });
    expect(errorCode(() => guard(file))).toBe("403 path_outside_root");
  });
});
