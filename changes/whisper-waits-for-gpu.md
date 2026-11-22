---
section: fixed
---

- **Local Whisper no longer falls back to the processor when the graphics card check is slow.** On a busy machine, the check for your graphics card could time out while CodeDen started. Whisper then ran on the processor for the whole run: each phrase took minutes, calls never got your words, and CodeDen slowed down. Whisper now waits for the check however long it takes (up to two minutes), asks again when it failed, and moves a model loaded on the processor over to the graphics card once the card is found.
