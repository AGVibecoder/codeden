import {
  type ContinueSessionRequestInit,
  type CutOffReason,
  canContinueAt,
  isCutOff,
  type Session,
} from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { Play, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useClient } from "@/lib/api";
import { until } from "@/lib/format";

const WHY: Record<CutOffReason, string> = {
  crash: "CodeDen stopped without warning while this session was working.",
  app_closed: "CodeDen was closed or restarted while this session was working.",
  usage_limit: "The provider's usage limit stopped this session's work.",
  error: "A provider error stopped this session's work.",
};

/** The current time, ticking each minute until `at` has passed (then it stops). */
function useNowUntil(at: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!at || Date.parse(at) <= now) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [at, now]);
  return now;
}

/**
 * Below the thread header for a cut-off session (§4.2): why it stopped, in red, and Continue,
 * which sends the agent a briefing of its task, where it was and what it changed. Nothing
 * continues it by itself; at a usage limit Continue waits for the reset, and the user can opt
 * in to continuing by itself once it has.
 */
export function CutOffNotice({ session }: { session: Session }) {
  const client = useClient();
  const cutOff = isCutOff(session) ? session.cutOff : null;
  const now = useNowUntil(cutOff?.resetsAt ?? null);
  const send = useMutation({
    mutationFn: (req: ContinueSessionRequestInit) => client.continueSession(session.id, req),
    onError: (e) => toast.error(e.message || "Couldn't continue the session"),
  });
  if (!cutOff) return null;

  const ready = canContinueAt(cutOff, now);
  const usage = cutOff.reason === "usage_limit";
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-status-failed/30 bg-status-failed/[0.07] px-4 py-2 text-2xs"
      data-testid="cut-off-notice"
    >
      <Unplug className="size-3.5 shrink-0 text-status-failed" />
      <p className="min-w-0 flex-1 text-foreground/90">
        <span className="font-medium text-status-failed">Cut off.</span> {WHY[cutOff.reason]}{" "}
        {usage && cutOff.resetsAt && !ready
          ? `Usage resets ${until(cutOff.resetsAt, now)}.`
          : "It waits for you: Continue sends it a briefing of its task, where it was and what it changed."}
      </p>
      {usage && cutOff.resetsAt && !ready && (
        <label
          htmlFor={`continue-on-reset-${session.id}`}
          className="flex shrink-0 items-center gap-1.5 text-muted-foreground"
        >
          <Switch
            id={`continue-on-reset-${session.id}`}
            size="sm"
            checked={cutOff.continueWhenReset}
            disabled={send.isPending}
            onCheckedChange={(on) => send.mutate({ mode: on ? "when_usage_resets" : "cancel" })}
          />
          Continue when usage resets
        </label>
      )}
      <Button
        size="xs"
        className="shrink-0"
        disabled={!ready || send.isPending}
        title={ready ? undefined : "Available once usage resets"}
        onClick={() => send.mutate({ mode: "now" })}
      >
        <Play /> Continue
      </Button>
    </div>
  );
}
