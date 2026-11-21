---
section: fixed
---

- **Chatterbox's install failed on a slow download.** PyTorch for AMD is one file of several gigabytes, and the installer gave up after 30 seconds without data ("network timeout"). It now waits up to 10 minutes and tries again up to five times.
