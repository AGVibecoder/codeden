import { dictationLanguages } from "@codeden/contracts";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingRow, useSettings } from "./settings-ui";

/** Languages offered for dictation (BCP 47 tags; Whisper uses the part before the dash). */
export const DICTATION_LANGUAGES: Record<string, string> = {
  "en-US": "English (US)",
  "en-GB": "English (UK)",
  "nl-NL": "Dutch",
  "nl-BE": "Dutch (Belgium)",
  "de-DE": "German",
  "fr-FR": "French",
  "es-ES": "Spanish",
  "it-IT": "Italian",
  "pt-PT": "Portuguese",
  "pt-BR": "Portuguese (Brazil)",
  "pl-PL": "Polish",
  "tr-TR": "Turkish",
  "ru-RU": "Russian",
  "uk-UA": "Ukrainian",
  "ar-SA": "Arabic",
  "hi-IN": "Hindi",
  "zh-CN": "Chinese",
  "ja-JP": "Japanese",
  "ko-KR": "Korean",
  "sv-SE": "Swedish",
  "da-DK": "Danish",
  "nb-NO": "Norwegian",
  "fi-FI": "Finnish",
  "el-GR": "Greek",
  "cs-CZ": "Czech",
  "ro-RO": "Romanian",
  "hu-HU": "Hungarian",
  "id-ID": "Indonesian",
  "af-ZA": "Afrikaans",
};

const label = (tag: string) => DICTATION_LANGUAGES[tag] ?? tag;

/**
 * Settings › Voice › Dictation: the languages you speak (§11.3), main one first, with a **+**
 * to add another. None is auto.
 */
export function DictationLanguagesRow() {
  const { settings, update } = useSettings();
  const d = settings.voice.dictation;
  const list = dictationLanguages(d);
  const save = (languages: string[]) =>
    // The older single `language` is cleared, so it never comes back when the list empties.
    update({ voice: { dictation: { languages, language: null } } });
  const unused = Object.keys(DICTATION_LANGUAGES).filter((t) => !list.includes(t));

  const help =
    list.length === 0
      ? d.engine === "browser"
        ? "Auto: the browser's language. Add the languages you speak."
        : "Auto: Whisper detects the language. Add the languages you speak so it only picks between those."
      : list.length === 1
        ? "Dictation is in this language. Add another to switch between them while you talk."
        : d.engine === "browser"
          ? "The browser engine only listens in the first language; Local (Whisper) switches between them."
          : d.engine === "local"
            ? "Whisper picks between these by itself. When it hears another language, it uses the first one, your main language."
            : "The cloud engine detects the language by itself.";

  return (
    <SettingRow
      label="Languages"
      help={`${help} English-only Whisper models always use English.`}
      stacked
    >
      <div className="flex flex-col gap-2">
        {list.map((tag, i) => (
          <div key={tag} className="flex items-center gap-2">
            <Select
              value={tag}
              onValueChange={(next) => save(list.map((t, j) => (j === i ? next : t)))}
            >
              <SelectTrigger size="sm" className="w-48" aria-label={`Dictation language ${i + 1}`}>
                <SelectValue>{label(tag)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {[tag, ...unused].map((t) => (
                  <SelectItem key={t} value={t}>
                    {label(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {i === 0 && list.length > 1 && (
              <span className="text-2xs text-muted-foreground">main</span>
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${label(tag)}`}
              onClick={() => save(list.filter((_, j) => j !== i))}
            >
              <X />
            </Button>
          </div>
        ))}
        {list.length < 8 && unused.length > 0 && (
          <Select value="" onValueChange={(tag) => save([...list, tag])}>
            <SelectTrigger size="sm" className="w-48" aria-label="Add a dictation language">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Plus className="size-3.5" /> {list.length ? "Add a language" : "Add your language"}
              </span>
            </SelectTrigger>
            {/* Nothing is selected here, so open below the button rather than aligned to an item. */}
            <SelectContent position="popper">
              {unused.map((t) => (
                <SelectItem key={t} value={t}>
                  {label(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </SettingRow>
  );
}
