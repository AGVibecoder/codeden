/**
 * The microphone dictation, calls and the wake word listen with (Settings › Voice › Dictation ›
 * Microphone, §11.3). Kept here so every capture asks for the same device; when that device is
 * gone the browser falls back to the system default (`ideal`, not `exact`).
 */

let preferred: string | null = null;

/** Set from the settings; null is the system default. */
export function setPreferredMicrophone(id: string | null): void {
  preferred = id;
}

export function preferredMicrophone(): string | null {
  return preferred;
}

/** Audio constraints for `getUserMedia`, asking for the chosen microphone when there is one. */
export function microphoneConstraints(
  base: MediaTrackConstraints = {},
  id: string | null = preferred,
): MediaTrackConstraints | true {
  if (!id) return Object.keys(base).length > 0 ? base : true;
  return { ...base, deviceId: { ideal: id } };
}

export interface Microphone {
  id: string;
  label: string;
}

/**
 * The microphones on this computer. Browsers hide their names until the page may use the
 * microphone, so this asks once for access when the names are missing.
 */
export async function listMicrophones(): Promise<Microphone[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return [];
  const read = async () =>
    (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications",
    );
  let inputs = await read();
  if (inputs.length > 0 && inputs.every((d) => !d.label)) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      inputs = await read();
    } catch {
      // Without access the list keeps its unnamed entries.
    }
  }
  return inputs.map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

/** Live loudness (0 to 1) of a microphone, for the Settings check. */
export async function watchMicrophoneLevel(
  id: string | null,
  onLevel: (level: number) => void,
): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: microphoneConstraints({}, id),
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const buffer = new Float32Array(analyser.fftSize);
  let frame = 0;
  const tick = () => {
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (const s of buffer) sum += s * s;
    onLevel(Math.sqrt(sum / buffer.length));
    frame = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(frame);
    source.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };
}
