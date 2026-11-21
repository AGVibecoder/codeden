import type { ChatterboxModel, ChatterboxPartState, ChatterboxStatus } from "@codeden/contracts";

/**
 * Chatterbox in the mock client: an install takes a few seconds per part, and voices are kept
 * in memory, so the Read aloud settings can be tried without a server.
 */
export function mockChatterbox(stepMs = 1500) {
  let runtime: ChatterboxPartState = "missing";
  const models: Record<ChatterboxModel, ChatterboxPartState> = {
    turbo: "missing",
    multilingual: "missing",
  };
  let step: string | null = null;
  const voices = [{ id: "annie", name: "Annie", builtIn: true }];

  const status = (): ChatterboxStatus => ({
    supported: true,
    unsupportedReason: null,
    gpu: "amd",
    gpuName: "AMD Radeon RX 7900 XTX",
    runtime,
    models: { ...models },
    step,
    detail: step ? "Working…" : null,
    error: null,
    voices: [...voices],
    location: "C:\\Users\\you\\.codeden\\deps\\chatterbox",
  });

  return {
    status,
    install(model: ChatterboxModel): ChatterboxStatus {
      if (step) return status();
      const needsRuntime = runtime !== "installed";
      if (needsRuntime) runtime = "installing";
      models[model] = "installing";
      step = needsRuntime ? "Installing PyTorch for AMD (about 3 GB)" : "Downloading the model";
      setTimeout(
        () => {
          runtime = "installed";
          models[model] = "installed";
          step = null;
        },
        stepMs * (needsRuntime ? 2 : 1),
      );
      return status();
    },
    addVoice(name: string): ChatterboxStatus {
      voices.push({ id: `voice-${voices.length}`, name, builtIn: false });
      return status();
    },
    removeVoice(id: string): ChatterboxStatus {
      const at = voices.findIndex((v) => v.id === id && !v.builtIn);
      if (at >= 0) voices.splice(at, 1);
      return status();
    },
  };
}
