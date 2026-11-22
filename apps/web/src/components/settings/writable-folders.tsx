import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingRow, useSettings } from "./settings-ui";

/** An absolute path on Windows (`E:\…`, `\\server\share`) or POSIX (`/…`). */
export const isAbsoluteFolder = (path: string) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path.trim());

/** `E:\PROJECTS\` and `E:\PROJECTS` are the same folder. */
const tidy = (path: string) => {
  const t = path.trim();
  return t.length > 3 ? t.replace(/[\\/]+$/, "") : t;
};

/**
 * Settings › Autonomy: folders outside the worktree where agents may write without asking
 * (`settings.autonomy.writableFolders`, §11.2).
 */
export function WritableFoldersRow() {
  const { settings, update } = useSettings();
  const folders = settings.autonomy.writableFolders;
  const [draft, setDraft] = useState("");
  const save = (next: string[]) => update({ autonomy: { writableFolders: next } });
  const candidate = tidy(draft);
  const valid =
    isAbsoluteFolder(candidate) &&
    !folders.some((f) => f.toLowerCase() === candidate.toLowerCase()) &&
    folders.length < 32;
  const add = () => {
    if (!valid) return;
    save([...folders, candidate]);
    setDraft("");
  };

  return (
    <SettingRow
      label="Folders agents may write to"
      help="Writes inside these folders don't ask, in Auto and Full, for new sessions and the next time a session starts. Writes anywhere else, Windows registry and environment changes, and secrets access still ask."
      stacked
    >
      <div className="flex flex-col gap-2">
        {folders.map((folder) => (
          <div key={folder} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={folder}>
              {folder}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${folder}`}
              onClick={() => save(folders.filter((f) => f !== folder))}
            >
              <X />
            </Button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            placeholder="E:\PROJECTS"
            className="h-8 flex-1 font-mono text-xs"
            aria-label="Folder agents may write to"
          />
          <Button size="sm" variant="outline" disabled={!valid} onClick={add}>
            <Plus /> Add
          </Button>
        </div>
        {draft.trim() && !isAbsoluteFolder(candidate) && (
          <p className="text-2xs text-status-waiting">Use a full path, such as E:\PROJECTS.</p>
        )}
      </div>
    </SettingRow>
  );
}
