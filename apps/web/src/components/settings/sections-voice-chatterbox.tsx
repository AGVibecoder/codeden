import {
  CHATTERBOX_LANGUAGES,
  CHATTERBOX_VOICE_MAX_SECONDS,
  CHATTERBOX_VOICE_MIN_SECONDS,
  type ChatterboxLanguage,
  type ChatterboxModel,
  type ChatterboxStatus,
  chatterboxModelFor,
} from "@codeden/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Plus, Trash2, Volume2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useClient } from "@/lib/api";
import { speak, speechQueue } from "@/lib/voice/speak";
import { SettingRow, useSettings } from "./settings-ui";

export const CHATTERBOX_KEY = ["chatterbox-status"];

/** A sentence to try a voice with, in the language it will speak. */
const SAMPLES: Partial<Record<ChatterboxLanguage, string>> = {
  en: "Hi, I'm your new voice. The checkout flake is fixed and verified.",
  nl: "Hoi, ik ben je nieuwe stem. De fout bij het afrekenen is opgelost.",
  de: "Hallo, ich bin deine neue Stimme. Der Fehler ist behoben.",
  fr: "Bonjour, je suis ta nouvelle voix. Le problème est corrigé.",
  es: "Hola, soy tu nueva voz. El error está corregido.",
  it: "Ciao, sono la tua nuova voce. L'errore è stato corretto.",
  pt: "Olá, sou a tua nova voz. O erro foi corrigido.",
};
export const sampleFor = (language: ChatterboxLanguage) => SAMPLES[language] ?? SAMPLES.en ?? "";

const MODEL_NAMES: Record<ChatterboxModel, string> = {
  turbo: "Chatterbox Turbo (English)",
  multilingual: "Chatterbox Multilingual",
};

/** Chatterbox's status, polled while something installs. */
export function useChatterbox(enabled = true) {
  const client = useClient();
  return useQuery({
    queryKey: CHATTERBOX_KEY,
    queryFn: () => client.voice.chatterboxStatus(),
    enabled,
    retry: false,
    refetchInterval: (query) => {
      const s = query.state.data;
      const busy =
        s?.runtime === "installing" ||
        s?.models.turbo === "installing" ||
        s?.models.multilingual === "installing";
      return busy ? 1000 : false;
    },
  });
}

/** True when the configured language can be spoken right now. */
export function chatterboxReady(s: ChatterboxStatus | undefined, language: ChatterboxLanguage) {
  return s?.runtime === "installed" && s.models[chatterboxModelFor(language)] === "installed";
}

/** Settings › Voice rows for Chatterbox (§11.3): install, language and the user's voices. */
export function ChatterboxRows() {
  const client = useClient();
  const queryClient = useQueryClient();
  const { settings, update } = useSettings();
  const ra = settings.voice.readAloud;
  const status = useChatterbox();
  const s = status.data;
  const model = chatterboxModelFor(ra.language);
  const busy = s?.runtime === "installing" || s?.models[model] === "installing";
  const put = (next: ChatterboxStatus) => queryClient.setQueryData(CHATTERBOX_KEY, next);

  const install = async () => {
    try {
      put(await client.voice.installChatterbox(model));
    } catch (e) {
      toast.error("Couldn't install Chatterbox", { description: (e as Error).message });
    }
  };

  const installHelp = !s
    ? status.error
      ? `Couldn't read Chatterbox: ${status.error.message}`
      : "Checking this computer…"
    : !s.supported
      ? s.unsupportedReason
      : busy
        ? `${s.step ?? "Installing…"}${s.detail ? ` · ${s.detail}` : ""}`
        : s.error
          ? `The last install failed: ${s.error}`
          : chatterboxReady(s, ra.language)
            ? `Installed for your ${s.gpu === "amd" ? "AMD" : "NVIDIA"} card (${s.gpuName}), in ${s.location}.`
            : `Installs Python, PyTorch for your ${s.gpu === "amd" ? "AMD" : "NVIDIA"} card (${s.gpuName}) and ${MODEL_NAMES[model]} into ${s.location}. About ${s.runtime === "installed" ? "3" : "10"} GB.`;

  return (
    <>
      <SettingRow label="Chatterbox" help={installHelp}>
        {s?.supported && !chatterboxReady(s, ra.language) && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void install()}>
            {busy ? <Loader2 className="animate-spin" /> : <Download />}
            {busy ? "Installing" : s.runtime === "installed" ? `Install ${model}` : "Install"}
          </Button>
        )}
      </SettingRow>
      <SettingRow
        label="Language"
        help={`Read aloud in one language. English uses ${MODEL_NAMES.turbo}, every other language ${MODEL_NAMES.multilingual}.`}
      >
        <Select
          value={ra.language}
          onValueChange={(language) =>
            update({ voice: { readAloud: { language: language as ChatterboxLanguage } } })
          }
        >
          <SelectTrigger size="sm" className="w-40" aria-label="Read-aloud language">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(CHATTERBOX_LANGUAGES).map(([code, name]) => (
              <SelectItem key={code} value={code}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      {s?.runtime === "installed" && <ChatterboxVoices status={s} onStatus={put} />}
    </>
  );
}

/** The user's voices: add one from a sound file, try it straight away, or remove it. */
function ChatterboxVoices({
  status,
  onStatus,
}: {
  status: ChatterboxStatus;
  onStatus: (s: ChatterboxStatus) => void;
}) {
  const client = useClient();
  const { settings, update } = useSettings();
  const language = settings.voice.readAloud.language;
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [adding, setAdding] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const ready = chatterboxReady(status, language);

  const test = (voice: string) => {
    setPlaying(voice);
    speechQueue.playNow({
      key: `voice-test-${Date.now()}`,
      play: () =>
        speak(client, settings, sampleFor(language), { voice })
          .catch((e: Error) => {
            toast.error("Couldn't play the voice", { description: e.message });
          })
          .finally(() => setPlaying((p) => (p === voice ? null : p))),
    });
  };

  const add = async () => {
    if (!file) return;
    setAdding(true);
    try {
      const next = await client.voice.addChatterboxVoice(name.trim() || file.name, file);
      const added = next.voices.find(
        (v) => !v.builtIn && !status.voices.some((old) => old.id === v.id),
      );
      onStatus(next);
      setName("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      if (added) {
        update({ voice: { readAloud: { voice: added.id } } });
        toast.success(`Added ${added.name}`);
        if (ready) test(added.id);
      }
    } catch (e) {
      toast.error("Couldn't add the voice", { description: (e as Error).message });
    } finally {
      setAdding(false);
    }
  };

  const remove = async (id: string) => {
    try {
      onStatus(await client.voice.removeChatterboxVoice(id));
      if (settings.voice.readAloud.voice === id) update({ voice: { readAloud: { voice: null } } });
    } catch (e) {
      toast.error("Couldn't remove the voice", { description: (e as Error).message });
    }
  };

  return (
    <SettingRow
      label="Voices"
      help={`Add a sound file of one person speaking clearly, ${CHATTERBOX_VOICE_MIN_SECONDS} to ${CHATTERBOX_VOICE_MAX_SECONDS} seconds (WAV, MP3, FLAC or OGG). Chatterbox copies the voice; it stays on this computer.`}
      stacked
    >
      <div className="flex flex-col gap-2">
        {status.voices.map((v) => (
          <div key={v.id} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate">
              {v.name}
              {v.builtIn && <span className="text-muted-foreground"> · built in</span>}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={!ready || playing !== null}
              onClick={() => test(v.id)}
              aria-label={`Test ${v.name}`}
            >
              {playing === v.id ? <Loader2 className="animate-spin" /> : <Volume2 />} Test
            </Button>
            {!v.builtIn && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove ${v.name}`}
                onClick={() => void remove(v.id)}
              >
                <Trash2 />
              </Button>
            )}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className="h-8 w-36 text-xs"
            aria-label="New voice name"
          />
          <input
            ref={fileInput}
            type="file"
            accept=".wav,.mp3,.flac,.ogg,audio/*"
            className="max-w-56 text-xs"
            aria-label="New voice sound file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <Button size="sm" variant="outline" disabled={!file || adding} onClick={() => void add()}>
            {adding ? <Loader2 className="animate-spin" /> : <Plus />} Add voice
          </Button>
        </div>
        {!ready && (
          <p className="text-2xs text-muted-foreground">
            Install the model for this language above to test voices.
          </p>
        )}
      </div>
    </SettingRow>
  );
}
