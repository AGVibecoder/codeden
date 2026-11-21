import type { LocalSttModel, LocalSttStatus, WhisperModelId } from "@codeden/contracts";

type ModelInfo = Pick<LocalSttModel, "id" | "label" | "hint" | "englishOnly" | "recommended"> & {
  bytes: number;
};

const MODELS: ModelInfo[] = [
  {
    id: "large-v3-turbo" as WhisperModelId,
    label: "Large v3 Turbo",
    hint: "Accurate in many languages; fast on a graphics card",
    bytes: 574_041_195,
    englishOnly: false,
    recommended: true,
  },
];

const RUNTIME_BYTES = 1_205_460;

/**
 * Local Whisper in the mock client: downloads progress on a timer (about four seconds per
 * model) so the Settings and setup UI can be tried without a server.
 */
export function mockLocalStt(stepMs = 200) {
  let runtime = 0;
  const received = new Map<WhisperModelId, number>();
  const timers = new Map<WhisperModelId, ReturnType<typeof setInterval>>();

  const status = (): LocalSttStatus => ({
    supported: true,
    platform: "win32-x64",
    unsupportedReason: null,
    runtime: {
      version: "1.1.3",
      state: runtime >= RUNTIME_BYTES ? "installed" : runtime > 0 ? "downloading" : "missing",
      receivedBytes: runtime,
      totalBytes: RUNTIME_BYTES,
      sizeOnDisk: runtime >= RUNTIME_BYTES ? 2_756_608 : null,
      error: null,
    },
    models: MODELS.map(({ bytes, ...m }) => {
      const got = received.get(m.id) ?? 0;
      const installed = got >= bytes;
      return {
        ...m,
        state: installed ? "installed" : timers.has(m.id) ? "downloading" : "missing",
        receivedBytes: Math.min(got, bytes),
        totalBytes: bytes,
        sizeOnDisk: installed ? bytes : null,
        error: null,
      };
    }),
    location: "~/.codeden/models/whisper",
  });

  return {
    status,
    installed: (id: WhisperModelId) =>
      status().models.find((m) => m.id === id)?.state === "installed",
    download(id: WhisperModelId): LocalSttStatus {
      const info = MODELS.find((m) => m.id === id);
      if (!info || timers.has(id) || (received.get(id) ?? 0) >= info.bytes) return status();
      received.set(id, 0);
      const timer = setInterval(() => {
        if (runtime < RUNTIME_BYTES) {
          runtime = Math.min(RUNTIME_BYTES, runtime + RUNTIME_BYTES / 2);
          return;
        }
        const next = (received.get(id) ?? 0) + info.bytes / 20;
        received.set(id, next);
        if (next >= info.bytes) {
          clearInterval(timer);
          timers.delete(id);
        }
      }, stepMs);
      timers.set(id, timer);
      return status();
    },
    remove(id: WhisperModelId): LocalSttStatus {
      clearInterval(timers.get(id));
      timers.delete(id);
      received.delete(id);
      return status();
    },
  };
}
