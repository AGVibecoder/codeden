import { Loader2, Mic, Phone, PhoneOff, Volume2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import { createCloudStt } from "@/lib/voice/cloud-stt";
import { stt as browserStt } from "@/lib/voice/engines";
import { WakeWordListener } from "@/lib/voice/wake-word";
import { callActive, useCallStore } from "@/stores/call";

const PHASE_LABEL = {
  listening: "Listening…",
  sending: "Sending…",
  thinking: "Orchestrator is thinking…",
  speaking: "Speaking…",
  ended: "Call ended",
} as const;

/** Starts a voice call with the orchestrator (§11.3); shows "In call" while one is on. */
export function CallButton({ className }: { className?: string }) {
  const phase = useCallStore((s) => s.state?.phase);
  const start = useCallStore((s) => s.start);
  const hangUp = useCallStore((s) => s.hangUp);
  const inCall = phase !== undefined && phase !== "ended";
  return (
    <Button
      size="xs"
      variant={inCall ? "default" : "outline"}
      className={cn("gap-1.5", className)}
      onClick={() => (inCall ? hangUp() : start())}
      title={inCall ? "Hang up" : "Talk with the orchestrator; its answers are read aloud"}
    >
      {inCall ? <PhoneOff className="size-3" /> : <Phone className="size-3" />}
      {inCall ? "Hang up" : "Call"}
    </Button>
  );
}

/** The call in progress, bottom right on every page: what it is doing, and hang up. */
export function CallPanel() {
  const state = useCallStore((s) => s.state);
  const level = useCallStore((s) => s.level);
  const hangUp = useCallStore((s) => s.hangUp);
  const lastError = useRef<string | null>(null);

  useEffect(() => {
    if (state?.error && state.error !== lastError.current) {
      lastError.current = state.error;
      toast.error("Call ended", { description: state.error });
    }
  }, [state?.error]);

  if (!state || state.phase === "ended") return null;
  const icon =
    state.phase === "listening" ? (
      <Mic className="size-4 text-status-done" />
    ) : state.phase === "speaking" ? (
      <Volume2 className="size-4 text-primary" />
    ) : (
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
    );
  return (
    <div
      data-testid="call-panel"
      className="fixed right-4 bottom-4 z-50 w-80 space-y-2 rounded-xl border border-border bg-background/95 p-3 shadow-lg backdrop-blur"
    >
      <div className="flex items-center gap-2 text-xs">
        {icon}
        <span className="flex-1 font-medium">Orchestrator · {PHASE_LABEL[state.phase]}</span>
        <Button size="xs" variant="destructive" className="gap-1" onClick={hangUp}>
          <PhoneOff className="size-3" /> Hang up
        </Button>
      </div>
      {state.phase === "listening" && (
        <div className="h-1 overflow-hidden rounded bg-muted">
          <div
            className="h-full bg-status-done transition-[width] duration-75"
            style={{ width: `${Math.min(100, Math.round((level ?? 0) * 400))}%` }}
          />
        </div>
      )}
      {(state.draft || state.heard) && (
        <p className="line-clamp-3 text-2xs text-muted-foreground">
          <span className="text-foreground">You:</span>{" "}
          {state.phase === "listening" ? state.draft || "…" : state.heard}
        </p>
      )}
      {state.reply && state.phase !== "listening" && state.phase !== "sending" && (
        <p className="line-clamp-4 text-2xs text-muted-foreground">
          <span className="text-foreground">Orchestrator:</span> {state.reply}
        </p>
      )}
    </div>
  );
}

/**
 * Listens for the wake phrase while it is switched on (Settings › Voice › Dictation) and no
 * call is on. Only the browser and local Whisper engines listen, so nothing reaches a cloud
 * engine between calls.
 */
export function WakeWord() {
  const client = useClient();
  const { settings } = useSettings();
  const wake = settings.voice.call.wakeWord;
  const choice = settings.voice.dictation.engine;
  const language = settings.voice.dictation.language;
  const phase = useCallStore((s) => s.state?.phase);
  const listener = useRef<WakeWordListener | null>(null);
  const allowed = wake.enabled && (choice === "browser" || choice === "local");

  useEffect(() => {
    if (!allowed) return;
    const engine = choice === "browser" ? browserStt : createCloudStt(client, choice);
    if (!engine.supported) return;
    const l = new WakeWordListener({
      engine,
      phrase: wake.phrase,
      language,
      onWake: (rest) => useCallStore.getState().start(rest),
      onError: (message) => console.warn("wake word:", message),
    });
    listener.current = l;
    if (!callActive()) l.start();
    return () => {
      l.stop();
      listener.current = null;
    };
  }, [allowed, choice, client, wake.phrase, language]);

  // Listen again once a call ends.
  useEffect(() => {
    if (phase === undefined || phase === "ended") listener.current?.resume();
  }, [phase]);

  return null;
}
