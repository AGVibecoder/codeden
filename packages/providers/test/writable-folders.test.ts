import { describe, expect, it } from "vitest";
import { classifyCommand, classifyWrite } from "../src/policy/risk";

// Settings › Autonomy › Folders agents may write to (§11.2) reach the classifier as extra roots.
describe("folders agents may write to", () => {
  const ctx = {
    cwd: "E:\\PROJECTS\\app",
    extraRoots: ["E:\\PROJECTS\\shared", "E:\\claude\\files"],
    platform: "win32" as const,
    home: "C:\\Users\\me",
    tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
  };

  it("lets writes inside them through without asking", () => {
    expect(classifyWrite("E:\\PROJECTS\\shared\\notes.md", ctx).risky).toBe(false);
    expect(classifyWrite("E:\\claude\\files\\report\\a.txt", ctx).risky).toBe(false);
  });

  it("still asks for writes anywhere else", () => {
    expect(classifyWrite("E:\\PROJECTS\\other\\x.ts", ctx)).toMatchObject({
      risky: true,
      action: "outside_worktree",
    });
    expect(classifyWrite("C:\\Windows\\System32\\x.dll", ctx).risky).toBe(true);
  });

  it("still asks for registry and environment changes", () => {
    expect(
      classifyCommand('reg add "HKCU\\Software\\X" /v Y /d 1 /f', { ...ctx, shell: "powershell" }),
    ).toMatchObject({ risky: true, action: "outside_worktree" });
    expect(classifyCommand("setx PATH E:\\tools", { ...ctx, shell: "powershell" }).risky).toBe(
      true,
    );
  });
});
