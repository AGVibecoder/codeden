import { join } from "node:path";
import { app } from "electron";
import { killProcessTree, runnerPid } from "../process-tree";
import { isProcessAlive } from "../server-plan";

/** electron-updater, loaded on first use (GitHub Releases, from `app-update.yml`). */
export async function loadUpdater(log: (m: string) => void) {
  const mod = (await import("electron-updater")) as unknown as {
    autoUpdater?: import("electron-updater").AppUpdater;
    default?: { autoUpdater: import("electron-updater").AppUpdater };
  };
  const updater = mod.autoUpdater ?? mod.default?.autoUpdater;
  if (!updater) throw new Error("electron-updater did not load");
  // Tests only: a local feed instead of GitHub Releases (like CODEDEN_UPDATE_REGISTRY for npm),
  // with its own download cache so a test never touches a real install's.
  const feed = process.env.CODEDEN_DESKTOP_UPDATE_URL;
  if (feed) {
    const config = join(app.getPath("userData"), "test-app-update.yml");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      config,
      `provider: generic\nurl: ${feed}\nupdaterCacheDirName: codeden-updater-test\n`,
    );
    updater.updateConfigPath = config;
    updater.setFeedURL({ provider: "generic", url: feed });
  }
  updater.logger = {
    info: (m: unknown) => log(`updater: ${String(m)}`),
    warn: (m: unknown) => log(`updater: ${String(m)}`),
    error: (m: unknown) => log(`updater: ${String(m)}`),
    debug: () => {},
  };
  return updater;
}

/**
 * Wait for the runner in the lock file to exit; if it outstays the timeout, end it with every
 * agent, terminal and browser it started.
 */
export async function waitForRunnerExit(
  lockFile: string,
  timeoutMs: number,
  log: (m: string) => void,
) {
  const pid = runnerPid(lockFile);
  if (!pid) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) await new Promise((r) => setTimeout(r, 200));
  if (isProcessAlive(pid)) {
    log(`app: runner ${pid} still running; stopping it and what it started`);
    killProcessTree(pid);
  }
}
