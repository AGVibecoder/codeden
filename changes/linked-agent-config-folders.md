---
section: fixed
---

- **A `~/.claude` or `~/.codex` folder moved to another drive couldn't be used.** When the folder was a link (a junction or symlink to its new place), the Agents page refused every file in it with "Path resolves outside the allowed folder". The link of the folder itself is now followed; a link inside it, or in a project, that leads elsewhere is still refused.
