import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * End a process and everything it started, now. On Windows ending only the pid leaves its
 * children running (agents, terminals, browsers under the runner; Whisper under the server),
 * so `taskkill /T` walks the tree. On POSIX the runner and the server's tools lead their own
 * process group, which is killed as a whole, then the pid itself.
 */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 10_000,
    });
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // gone, or not a group leader
    }
  }
}

/** The pid of the runner in its lock file, or null when there is none. */
export function runnerPid(lockFile: string): number | null {
  try {
    return Number(JSON.parse(readFileSync(lockFile, "utf8")).pid) || null;
  } catch {
    return null;
  }
}
