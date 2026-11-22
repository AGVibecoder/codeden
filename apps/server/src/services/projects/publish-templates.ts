import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PublishGithubPlan } from "@codeden/contracts";

export type PublishTemplate = NonNullable<PublishGithubPlan["template"]>;

interface TemplateRules {
  /** The `.gitignore` written when the folder has none. */
  gitignore: string[];
  /** Folder names left out wherever they are (for the size estimate). */
  skipDirs: string[];
  /** Patterns stored with Git LFS. */
  lfs: string[];
}

const COMMON_IGNORE = [".env", ".env.*", "!.env.example", ".DS_Store", "Thumbs.db"];

const RULES: Record<PublishTemplate, TemplateRules> = {
  unreal: {
    gitignore: [
      "# Unreal Engine: generated and per-machine files",
      "Binaries/",
      "Intermediate/",
      "Saved/",
      "DerivedDataCache/",
      "Build/",
      "Plugins/*/Binaries/",
      "Plugins/*/Intermediate/",
      ".vs/",
      ".vscode/",
      ".idea/",
      "*.sln",
      "*.suo",
      "*.VC.db",
      "*.VC.opendb",
      "*.opensdf",
      "*.sdf",
    ],
    skipDirs: [
      "Binaries",
      "Intermediate",
      "Saved",
      "DerivedDataCache",
      "Build",
      ".vs",
      ".vscode",
      ".idea",
    ],
    lfs: ["*.uasset", "*.umap", "*.fbx", "*.wav", "*.mp4", "*.psd", "*.exr", "*.tga"],
  },
  unity: {
    gitignore: [
      "# Unity: generated and per-machine files",
      "Library/",
      "Temp/",
      "Obj/",
      "Build/",
      "Builds/",
      "Logs/",
      "UserSettings/",
      "MemoryCaptures/",
      ".vs/",
      ".idea/",
      "*.csproj",
      "*.sln",
      "*.suo",
    ],
    skipDirs: ["Library", "Temp", "Obj", "Build", "Builds", "Logs", "UserSettings", ".vs", ".idea"],
    lfs: ["*.psd", "*.fbx", "*.wav", "*.mp4", "*.exr", "*.tga"],
  },
  node: {
    gitignore: ["node_modules/", "dist/", "build/", ".next/", "coverage/", "*.log"],
    skipDirs: ["node_modules", "dist", "build", ".next", "coverage"],
    lfs: [],
  },
  python: {
    gitignore: ["__pycache__/", "*.pyc", ".venv/", "venv/", ".pytest_cache/", "dist/", "build/"],
    skipDirs: ["__pycache__", ".venv", "venv", ".pytest_cache", "dist", "build"],
    lfs: [],
  },
};

/** What kind of project the folder holds, from the files at its top level. */
export function detectTemplate(dir: string): PublishTemplate | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  if (names.some((n) => n.toLowerCase().endsWith(".uproject"))) return "unreal";
  if (names.includes("Assets") && names.includes("ProjectSettings")) return "unity";
  if (names.includes("package.json")) return "node";
  if (["pyproject.toml", "requirements.txt", "setup.py"].some((n) => names.includes(n))) {
    return "python";
  }
  return null;
}

export function templateRules(template: PublishTemplate | null): TemplateRules {
  return template ? RULES[template] : { gitignore: [], skipDirs: [], lfs: [] };
}

/** The `.gitignore` content for a template. */
export function gitignoreFor(template: PublishTemplate): string {
  return `${[...RULES[template].gitignore, "", ...COMMON_IGNORE].join("\n")}\n`;
}

/** True when the folder has a `.gitignore` already. */
export function hasGitignore(dir: string): boolean {
  return existsSync(join(dir, ".gitignore"));
}

/** True when `name` matches one of the simple `*.ext` LFS patterns. */
export function coveredByLfs(name: string, patterns: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return patterns.some((p) => p.startsWith("*.") && lower.endsWith(p.slice(1).toLowerCase()));
}
