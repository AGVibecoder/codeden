---
section: fixed
---

- **A session's chat no longer says "Working" forever after it finished.** When a live update didn't reach the chat, it kept showing the turn as running, with a timer that went on counting, while the sidebar already showed the session at rest. The chat now notices that, waits three seconds for the update, and then reloads the session's transcript. An update that doesn't match what the app expects is no longer dropped without a word: it is logged and the chat reloads.
