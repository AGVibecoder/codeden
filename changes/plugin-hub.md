---
section: added
---

- **Plugins on demand.** Your MCP servers (such as Unreal's) no longer load into every Claude Code worker, where their tools cost context in every turn and a server whose program wasn't open showed a warning. Workers now start with only CodeDen's own tools and switch a plugin on with `use_plugin` when their task needs it: CodeDen opens its program first when it has a start command, and the tools arrive in the running turn. The worker switches it off with `close_plugin` when it's done (or leaves it on while it still needs it), and a program CodeDen opened closes once no worker uses it; one you opened yourself stays open. Turn it off in Settings › Autonomy › Plugins on demand.
