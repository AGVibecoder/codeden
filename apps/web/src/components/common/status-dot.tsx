import type { SessionStatus } from "@codeden/contracts";
import { statusTone, type Tone } from "@/lib/format";
import { cn } from "@/lib/utils";

const toneClass: Record<Exclude<Tone, "cut_off">, string> = {
  running: "bg-status-running",
  waiting: "bg-status-waiting",
  done: "bg-status-done",
  failed: "bg-status-failed",
  idle: "bg-status-idle/70",
};

/**
 * Session status dot: running pulses with a soft halo, waiting gets a steady ring. A cut-off
 * session (§4.2) shows two circles: a green one with a yellow drop slipping out of it.
 */
export function StatusDot({
  status,
  tone,
  className,
}: {
  status?: SessionStatus;
  tone?: Tone;
  className?: string;
}) {
  const t = tone ?? (status ? statusTone[status] : "idle");
  if (t === "cut_off") {
    return (
      <span
        className={cn("relative inline-flex size-2 shrink-0", className)}
        aria-hidden
        data-tone="cut_off"
      >
        <span className="relative inline-block size-2 rounded-full bg-status-done" />
        <span className="absolute -right-0.5 -bottom-0.5 inline-block size-[5px] animate-cut-off-drop rounded-full bg-status-waiting ring-1 ring-background" />
      </span>
    );
  }
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)} aria-hidden>
      {t === "running" && (
        <span className="absolute inset-0 animate-ping rounded-full bg-status-running/60 [animation-duration:1.8s]" />
      )}
      <span
        className={cn(
          "relative inline-block size-2 rounded-full",
          toneClass[t],
          t === "waiting" && "ring-[3px] ring-status-waiting/20",
        )}
      />
    </span>
  );
}
