---
section: added
---

- **Start command for HTTP and SSE MCP servers.** A server whose program has to be running first (an editor that serves MCP while it is open, a local service) can now have a start command on the Agents page. When nothing answers at its URL, **Test** runs the command, waits for the address to answer, then connects. The command is kept on this computer only, never in the shared config file, and what it starts is left running.
