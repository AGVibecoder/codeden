import { execFile } from "node:child_process";
import type { ChatterboxGpu } from "@codeden/contracts";

/** The card the install picks PyTorch for, and its name; `gpu` null when none is supported. */
export interface GpuInfo {
  gpu: ChatterboxGpu | null;
  name: string | null;
}

/**
 * Pick the card from the display adapters' names: an NVIDIA card first (a laptop can have an
 * AMD or Intel chip beside it), then an AMD Radeon one. Anything else is not supported.
 */
export function pickGpu(names: string[]): GpuInfo {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  const nvidia = clean.find((n) => /nvidia/i.test(n));
  if (nvidia) return { gpu: "nvidia", name: nvidia };
  const amd = clean.find((n) => /\bamd\b|radeon/i.test(n));
  if (amd) return { gpu: "amd", name: amd };
  return { gpu: null, name: clean[0] ?? null };
}

/**
 * The display adapters Windows reports (an empty list when the query fails). The query can take
 * a long time on a busy machine (CodeDen starting next to a game engine and a voice model), so
 * it gets two minutes.
 */
export function windowsAdapterNames(timeoutMs = 120_000): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_VideoController).Name"],
      { windowsHide: true, timeout: timeoutMs },
      (error, stdout) => resolve(error ? [] : String(stdout).split(/\r?\n/)),
    );
  });
}
