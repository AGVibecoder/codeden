import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listMicrophones, watchMicrophoneLevel } from "@/lib/voice/microphone";
import { SettingRow, useSettings } from "./settings-ui";

const DEFAULT = "__default__";

/**
 * Settings › Voice › Dictation › Microphone (§11.3): which microphone dictation, calls and the
 * wake word listen with, and a live level meter to check that it hears you.
 */
export function MicrophoneRow() {
  const { settings, update } = useSettings();
  const chosen = settings.voice.dictation.microphone;
  const browserEngine = settings.voice.dictation.engine === "browser";
  const mics = useQuery({ queryKey: ["microphones"], queryFn: listMicrophones, retry: false });
  const [level, setLevel] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopCheck = useRef<(() => void) | null>(null);

  const stop = () => {
    stopCheck.current?.();
    stopCheck.current = null;
    setLevel(null);
  };
  // Release the microphone when leaving Settings.
  useEffect(() => () => stopCheck.current?.(), []);

  // Refresh the list when a microphone is plugged in or out.
  useEffect(() => {
    const devices = navigator.mediaDevices;
    if (!devices?.addEventListener) return;
    const refresh = () => void mics.refetch();
    devices.addEventListener("devicechange", refresh);
    return () => devices.removeEventListener("devicechange", refresh);
  }, [mics.refetch]);

  const list = mics.data ?? [];
  const missing = chosen && !list.some((m) => m.id === chosen.id);
  const check = async (id: string | null) => {
    stop();
    setError(null);
    try {
      stopCheck.current = await watchMicrophoneLevel(id, setLevel);
      setLevel(0);
    } catch {
      setError("CodeDen can't use this microphone. Check that the browser may use it.");
    }
  };

  return (
    <SettingRow
      label="Microphone"
      help={
        <>
          {missing
            ? `${chosen.label || "The chosen microphone"} isn't connected; the system default is used until it is. `
            : "Used for dictation, calls, the wake word and the Whisper test. "}
          {browserEngine &&
            "The Browser engine always listens with the system default; pick Local (Whisper) to use this choice. "}
          {error && <span className="text-status-failed">{error}</span>}
        </>
      }
    >
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex items-center gap-2">
          <Select
            value={chosen?.id ?? DEFAULT}
            onValueChange={(id) => {
              const mic = list.find((m) => m.id === id);
              update({
                voice: {
                  dictation: { microphone: mic ? { id: mic.id, label: mic.label } : null },
                },
              });
              if (stopCheck.current) void check(mic?.id ?? null);
            }}
          >
            <SelectTrigger className="h-8 w-56 text-xs" aria-label="Microphone">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value={DEFAULT}>System default</SelectItem>
              {list.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
              {missing && (
                <SelectItem value={chosen.id} disabled>
                  {chosen.label || "Chosen microphone"} (not connected)
                </SelectItem>
              )}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => (level === null ? void check(chosen?.id ?? null) : stop())}
          >
            {level === null ? "Check" : "Stop"}
          </Button>
        </div>
        {level !== null && (
          <div className="flex w-full items-center gap-2" data-testid="microphone-level">
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-status-done transition-[width] duration-75"
                style={{ width: `${Math.min(100, Math.round(level * 400))}%` }}
              />
            </div>
            <span className="text-2xs text-muted-foreground">Say something</span>
          </div>
        )}
      </div>
    </SettingRow>
  );
}
