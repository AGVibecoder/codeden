---
section: fixed
---

- **The orchestrator keeps working after CodeDen's home moves.** With `CODEDEN_HOME` pointing somewhere new, messages to the orchestrator failed with "…\orchestrator does not exist on this runner", because it still looked for its folder in the old place. It now opens in the current home's folder.
