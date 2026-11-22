---
section: fixed
---

- **A slow speech engine no longer makes the whole app hang.** During a call or dictation, at most two speech clips are sent to the server at once; the rest wait their turn. Before, every phrase was sent right away, so when speech-to-text was slow the open uploads took all of the app's connections and Settings, the Whisper and Chatterbox checks and other views waited forever. Hanging up drops the clips that haven't come back, and local Whisper skips a clip that was cancelled while it waited.
