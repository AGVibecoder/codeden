---
section: fixed
---

- **A failed MCP server reconnects by itself.** A Claude Code session whose MCP server wasn't reachable when it started (Unreal's MCP plugin before the editor was open, say) kept "failed" and went without its tools until the session restarted. It now tries the server again every 30 seconds while it runs, so the tools arrive as soon as the program is up and the notice goes away.
