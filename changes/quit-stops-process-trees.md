---
section: fixed
---

- **Quitting the desktop app no longer leaves processes behind on Windows.** When the runner or the server took too long to stop, only that one process was ended, so the agents, terminals, browsers, local Whisper and the voice model they started kept running. Now everything they started is stopped with them, also when the quit runs out of time.
