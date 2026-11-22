import { describe, expect, it } from "vitest";
import { AcpPolicy } from "../src/acp/policy";
import { ClaudePolicy } from "../src/claude/permissions";
import type { RiskContext } from "../src/policy/risk";

/**
 * Folders agents may write to (Settings › Folders agents may write to) change mid-session: a
 * running session's checks take a folder added in Settings from its next tool call.
 */
const ctx: RiskContext = {
  cwd: "E:\\CodeDen\\data\\wt\\game\\a604d3f3",
  platform: "win32",
  home: "C:\\Users\\me",
  extraRoots: ["E:\\PROJECTS"],
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
};
const log = { file_path: "E:\\claude\\files\\build.log", content: "x" };

describe("writable folders changed mid-session", () => {
  it("apply to Claude's next tool call", () => {
    const policy = new ClaudePolicy("auto", ctx);
    expect(policy.gate("Write", log).ask).toBe(true);
    policy.setWritableFolders(["E:\\PROJECTS", "E:\\claude"]);
    expect(policy.gate("Write", log).ask).toBe(false);
    // A folder taken off the list asks again.
    policy.setWritableFolders(["E:\\PROJECTS"]);
    expect(policy.gate("Write", log).ask).toBe(true);
  });

  it("apply to a command writing there (Git Bash paths too)", () => {
    const policy = new ClaudePolicy("auto", ctx);
    const command = { command: "cat > /e/claude/files/fix.py <<'EOF'\nprint(1)\nEOF" };
    expect(policy.gate("Bash", command).ask).toBe(true);
    policy.setWritableFolders(["E:\\claude"]);
    expect(policy.gate("Bash", command).ask).toBe(false);
  });

  it("apply to ACP agents' next permission request", () => {
    const policy = new AcpPolicy("auto", ctx);
    const call = {
      toolCallId: "t1",
      kind: "edit",
      title: "Write build.log",
      locations: [{ path: log.file_path }],
      rawInput: log,
    } as unknown as Parameters<AcpPolicy["decide"]>[0];
    const before = policy.decide(call);
    policy.setWritableFolders(["E:\\claude"]);
    const after = policy.decide(call);
    expect(before.kind).not.toBe(after.kind);
  });
});
