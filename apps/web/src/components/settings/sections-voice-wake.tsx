import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SettingRow, useSettings } from "./settings-ui";

/** Settings › Voice › Dictation rows for the call's wake word (§11.3). */
export function WakeWordRows() {
  const { settings, update } = useSettings();
  const wake = settings.voice.call.wakeWord;
  const engine = settings.voice.dictation.engine;
  const listens = engine === "browser" || engine === "local";
  const [phrase, setPhrase] = useState(wake.phrase);
  useEffect(() => setPhrase(wake.phrase), [wake.phrase]);
  const save = () => {
    const next = phrase.trim();
    if (next.length >= 2 && next !== wake.phrase) {
      update({ voice: { call: { wakeWord: { phrase: next } } } });
    } else setPhrase(wake.phrase);
  };

  return (
    <>
      <SettingRow
        label="Wake word"
        help={
          listens
            ? "Say it while CodeDen is open to start a voice call with the orchestrator. The microphone stays on to listen for it; what you say only leaves this computer once a call starts."
            : "Works with the Browser and Local (Whisper) engines, so nothing goes to a cloud engine while you aren't in a call."
        }
      >
        <Switch
          aria-label="Wake word"
          checked={wake.enabled}
          disabled={!listens && !wake.enabled}
          onCheckedChange={(enabled) => update({ voice: { call: { wakeWord: { enabled } } } })}
        />
      </SettingRow>
      {wake.enabled && (
        <SettingRow
          label="Wake phrase"
          help="Two or three words work best. Words said right after it are your first message."
        >
          <Input
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            className="h-8 w-44 text-xs"
            aria-label="Wake phrase"
          />
        </SettingRow>
      )}
    </>
  );
}
