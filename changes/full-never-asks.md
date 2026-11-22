---
section: changed
---

- **Full permissions never ask, outside the worktree too.** A session or factory worker at Full used to stop and ask before every write or delete outside its worktree (a build log in another folder, a script next to the project). Full now runs those without asking, on every agent (Claude, Codex, OpenCode, Cursor, Gemini CLI). Only a few things still ask at Full: CodeDen's own home and credentials, an agent CLI's login (reading, overwriting or deleting it would leak it or log you out), an agent's own settings or allow-list file, and a delete that would wipe a whole drive or your home folder. Auto is unchanged, and Settings › Folders agents may write to is now about Auto.
