import { dictationLanguageFor } from "@codeden/contracts";
import { Loader2, Mic, Phone, PhoneOff, Volume2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useClient } from "@/lib/api";
import { useProject } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { createCloudStt } from "@/lib/voice/cloud-stt";
import { stt as browserStt } from "@/lib/voice/engines";
import { setPreferredMicrophone } from "@/lib/voice/microphone";
import { WakeWordListener } from "@/lib/voice/wake-word";
import { type CallTarget, callActive, sameTarget, useCallStore } from "@/stores/call";

const PHASE_LABEL = {
  listening: "Listening…",
  thinking: "Working on it…",
  speaking: "Speaking…",
  ended: "Call ended",
} as const;

/** "the orchestrator" or "the codeden project manager", for labels. */
function useTargetName(target: CallTarget | null): string {
  const project = useProject(target?.role === "pm" ? target.projectId : null);
  if (!target || target.role === "orchestrator") return "the orchestrator";
  return `the ${project?.name ?? "project"} project manager`;
}

/**
 * Starts a voice call with the orchestrator or a project manager (§11.3), next to the
 * dictation button in its message box; hangs up while a call is on. Only one call runs at a
 * time: while a call with someone else is on, the button hangs that one up, so a call that
 * got stuck never blocks a new one.
 */
export function CallButton({ target }: { target: CallTarget }) {
  const phase = useCallStore((s) => s.state?.phase);
  const current = useCallStore((s) => s.target);
  const start = useCallStore((s) => s.start);
  const hangUp = useCallStore((s) => s.hangUp);
  const name = useTargetName(target);
  const otherName = useTargetName(current);
  const live = phase !== undefined && phase !== "ended";
  const inCall = live && sameTarget(current, target);
  const busy = live && !inCall;
  const label = inCall
    ? "Hang up"
    : busy
      ? `Hang up the call with ${otherName}`
      : `Call ${name}; the answers are spoken`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => (inCall || busy ? hangUp() : start(target))}
            aria-label={label}
            aria-pressed={inCall}
            className={cn(
              "text-muted-foreground",
              (inCall || busy) &&
                "bg-status-failed/12 text-status-failed hover:bg-status-failed/20 hover:text-status-failed",
            )}
          >
            {inCall || busy ? <PhoneOff /> : <Phone />}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** The call in progress, bottom right on every page: what it is doing, and hang up. */
export function CallPanel() {
  const state = useCallStore((s) => s.state);
  const level = useCallStore((s) => s.level);
  const hangUp = useCallStore((s) => s.hangUp);
  const target = useCallStore((s) => s.target);
  const name = useTargetName(target);
  const headset = useSettings().settings.voice.call.audio === "headset";
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
        <span className="flex-1 font-medium">
          {name.charAt(0).toUpperCase() + name.slice(1)} · {PHASE_LABEL[state.phase]}
          {state.phase === "speaking" && (
            <span className="font-normal text-muted-foreground">
              {headset ? " talk to interrupt" : " microphone paused"}
            </span>
          )}
        </span>
        <Button size="xs" variant="destructive" className="gap-1" onClick={hangUp}>
          <PhoneOff className="size-3" /> Hang up
        </Button>
      </div>
      {/* The microphone is on for the whole call. */}
      <div className="flex items-center gap-1.5">
        <Mic className="size-3 text-muted-foreground" />
        <div className="h-1 flex-1 overflow-hidden rounded bg-muted">
          <div
            className="h-full bg-status-done transition-[width] duration-75"
            style={{ width: `${Math.min(100, Math.round((level ?? 0) * 400))}%` }}
          />
        </div>
      </div>
      {(state.draft || state.heard) && (
        <p className="line-clamp-3 text-2xs text-muted-foreground">
          <span className="text-foreground">You:</span> {state.draft || state.heard}
        </p>
      )}
      {state.reply && (
        <p className="line-clamp-4 text-2xs text-muted-foreground">
          <span className="text-foreground">
            {target?.role === "pm" ? "Project manager" : "Orchestrator"}:
          </span>{" "}
          {state.reply}
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
  const language = dictationLanguageFor(settings.voice.dictation, choice);
  const phase = useCallStore((s) => s.state?.phase);
  const listener = useRef<WakeWordListener | null>(null);
  const allowed = wake.enabled && (choice === "browser" || choice === "local");
  const microphone = settings.voice.dictation.microphone?.id ?? null;

  // Every capture (dictation, calls, the Whisper test, this listener) asks for this device.
  useEffect(() => setPreferredMicrophone(microphone), [microphone]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new microphone restarts the listener.
  useEffect(() => {
    if (!allowed) return;
    const engine = choice === "browser" ? browserStt : createCloudStt(client, choice);
    if (!engine.supported) return;
    const l = new WakeWordListener({
      engine,
      phrase: wake.phrase,
      language,
      // The wake word always calls the orchestrator.
      onWake: (rest) =>
        useCallStore.getState().start({ role: "orchestrator", projectId: null }, rest),
      onError: (message) => console.warn("wake word:", message),
    });
    listener.current = l;
    if (!callActive()) l.start();
    return () => {
      l.stop();
      listener.current = null;
    };
  }, [allowed, choice, client, wake.phrase, language, microphone]);

  // Listen again once a call ends.
  useEffect(() => {
    if (phase === undefined || phase === "ended") listener.current?.resume();
  }, [phase]);

  return null;
}
