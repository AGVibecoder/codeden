"""Chatterbox for CodeDen's read aloud (the CodeDen server starts this with the Python it installed).

    python chatterbox_tts.py check                  prints the graphics card PyTorch sees; fails without one
    python chatterbox_tts.py download <model>       downloads a model: turbo (English) or multilingual
    python chatterbox_tts.py serve                  speaks, one JSON request per line on stdin

serve, in:  {"id": 7, "op": "speak", "text": "...", "lang": "nl", "voice": "<clip>", "out": "<file.wav>"}
            {"id": 8, "op": "probe", "path": "<clip>"}        (how long a clip is, in seconds)
            {"id": 9, "op": "load", "lang": "nl"}             (load that language's model ahead of speaking)
       out: "ready" once started, then per request "ok <id> <value>" or "err <id> <message>".
English is spoken with Chatterbox Turbo, every other language with Chatterbox Multilingual; only one of
them is kept loaded, so they don't share the graphics card. Other lines on stderr are only for the log.

The server sets HF_HOME and the other cache folders, so everything stays in CodeDen's data folder.
"""
import json
import os
import re
import sys
import time

for _name in ("stdout", "stderr"):
    _s = getattr(sys, _name)
    if _s is not None and hasattr(_s, "reconfigure"):
        _s.reconfigure(errors="replace", line_buffering=True)

import logging  # noqa: E402

logging.getLogger("chatterbox").setLevel(logging.ERROR)

TURBO_REPO = "ResembleAI/chatterbox-turbo"
TURBO_FILES = ["*.safetensors", "*.json", "*.txt", "*.pt", "*.model"]
MTL_REPO = "ResembleAI/chatterbox"
MTL_FILES = ["ve.pt", "t3_mtl23ls_v2.safetensors", "s3gen.pt", "grapheme_mtl_merged_expanded_v1.json",
             "conds.pt", "Cangjie5_TC.json"]
TAIL_TOKENS = 12  # after the last word, at most this many more speech tokens (25 = 1 s)


def log(text):
    print(text, file=sys.stderr, flush=True)


def check():
    import torch
    if not torch.cuda.is_available():  # AMD's ROCm build answers to "cuda" too
        print("No graphics card PyTorch can use was found", flush=True)
        return 1
    print(f"ok {torch.__version__} {torch.cuda.get_device_name(0)}", flush=True)
    return 0


def download(model):
    from huggingface_hub import snapshot_download
    if model == "turbo":
        snapshot_download(repo_id=TURBO_REPO, allow_patterns=TURBO_FILES)
    elif model == "multilingual":
        snapshot_download(repo_id=MTL_REPO, repo_type="model", revision="main", allow_patterns=MTL_FILES)
    else:
        print(f"Unknown model: {model}", flush=True)
        return 1
    print("ok", flush=True)
    return 0


def _patch_analyzer(torch):
    """Chatterbox keeps making sound after the last word until its check notices; stop a short time after."""
    from chatterbox.models.t3.inference import alignment_stream_analyzer as asa
    cls = asa.AlignmentStreamAnalyzer
    if getattr(cls, "_tail_patched", False):
        return
    orig = cls.step

    def step(self, logits, next_token=None):
        logits = orig(self, logits, next_token)
        if self.completed_at is not None and self.curr_frame_pos - self.completed_at > TAIL_TOKENS:
            logits = -(2 ** 15) * torch.ones_like(logits)
            logits[..., self.eos_idx] = 2 ** 15
        return logits

    cls.step, cls._tail_patched = step, True


def _fast_attention(model):
    """Only the 3 layers Chatterbox's end check reads need the slow 'eager' attention; the rest use SDPA."""
    import copy
    from chatterbox.models.t3.inference.alignment_stream_analyzer import LLAMA_ALIGNED_HEADS
    tf = model.t3.tfmr
    keep = {layer for layer, _ in LLAMA_ALIGNED_HEADS}
    for i, layer in enumerate(tf.layers):
        if i not in keep:
            cfg = copy.copy(tf.config)
            cfg._attn_implementation = "sdpa"
            layer.self_attn.config = cfg


def sentences(text, shortest=12, longest=220):
    """Splits text into sentences Chatterbox speaks well; very short bits join the next, long ones split at a comma."""
    parts = [p.strip() for p in re.split(r"(?<=[.!?…。！？])\s+", text.strip()) if p.strip()]
    out = []
    for p in parts:
        while len(p) > longest:
            cut = max(p.rfind(c, 0, longest) for c in ",;:，、")
            if cut < shortest:
                break
            out.append(p[:cut + 1].strip())
            p = p[cut + 1:].strip()
        if out and len(out[-1]) < shortest:
            out[-1] += " " + p
        else:
            out.append(p)
    if len(out) > 1 and len(out[-1]) < shortest:
        out[-2] += " " + out.pop()
    return out or [text]


class Voice:
    """The loaded model (one at a time) and the voice clip it was prepared with."""

    def __init__(self):
        import torch
        self.torch = torch
        self.kind = None
        self.model = None
        self.voice_key = None
        self.own_conds = None
        self.vad = None

    def load(self, kind):
        if self.kind == kind:
            return
        torch = self.torch
        if not torch.cuda.is_available():
            raise RuntimeError("No graphics card PyTorch can use was found")
        self.model = None
        torch.cuda.empty_cache()
        t0 = time.perf_counter()
        if kind == "turbo":
            from chatterbox.tts_turbo import ChatterboxTurboTTS
            self.model = ChatterboxTurboTTS.from_pretrained("cuda")
        else:
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS
            self.model = ChatterboxMultilingualTTS.from_pretrained(device=torch.device("cuda"))
            _patch_analyzer(torch)
            _fast_attention(self.model)
        self.kind, self.voice_key, self.own_conds = kind, None, self.model.conds
        log(f"Chatterbox {kind} loaded in {time.perf_counter() - t0:.1f} s")

    def prepare(self, voice):
        key = (voice, os.path.getmtime(voice)) if voice else None
        if key == self.voice_key:  # the clip is read only when it changes
            return
        if voice:
            self.model.prepare_conditionals(voice, exaggeration=0.5)
        else:
            self.model.conds = self.own_conds
        self.voice_key = key

    def trim_tail(self, samples, sr, pad=0.12, fade=0.03):
        """Cuts whatever comes after the last speech (Silero finds it), with a short pad and fade-out."""
        import numpy as np
        torch = self.torch
        try:
            from silero_vad import get_speech_timestamps, load_silero_vad
        except ImportError:
            return samples
        if self.vad is None:
            self.vad = load_silero_vad()
        x16 = np.interp(np.arange(0, len(samples), sr / 16000), np.arange(len(samples)), samples).astype(np.float32)
        ts = get_speech_timestamps(torch.from_numpy(x16), self.vad, sampling_rate=16000, return_seconds=True)
        if not ts:
            return samples
        end = min(len(samples), int((ts[-1]["end"] + pad) * sr))
        out = samples[:end].copy()
        n = min(int(fade * sr), len(out))
        out[len(out) - n:] *= np.linspace(1, 0, n, dtype=out.dtype)
        return out

    def speak(self, text, lang, voice, out_path):
        import numpy as np
        import soundfile as sf
        torch = self.torch
        kind = "turbo" if lang == "en" else "multilingual"
        self.load(kind)
        self.prepare(voice)
        sr = self.model.sr
        gap = np.zeros(int(0.25 * sr), dtype=np.float32)
        pieces = []
        t0 = time.perf_counter()
        for sentence in sentences(text):
            with torch.inference_mode():
                if kind == "turbo":
                    wav = self.model.generate(sentence)
                else:
                    wav = self.model.generate(sentence, language_id=lang, exaggeration=0.5, cfg_weight=0.5)
            samples = wav.squeeze().detach().float().cpu().numpy()
            try:
                samples = self.trim_tail(samples, sr)
            except Exception:  # noqa: BLE001  (the sound as it is)
                pass
            pieces += [samples, gap]
        audio = np.concatenate(pieces[:-1]) if pieces else gap
        sf.write(out_path, audio, sr, subtype="PCM_16")
        log(f"{kind}: {len(audio) / sr:.1f} s of speech in {time.perf_counter() - t0:.1f} s")


def serve():
    voice = Voice()
    print("ready", flush=True)
    for line in sys.stdin:
        line = line.strip().lstrip("﻿")
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        n = req.get("id", 0)
        try:
            if req.get("op") == "load":  # load the model a language needs, ahead of speaking
                lang = req.get("lang") or "en"
                voice.load("turbo" if lang == "en" else "multilingual")
                print(f"ok {n} loaded", flush=True)
                continue
            if req.get("op") == "probe":
                import librosa
                print(f"ok {n} {librosa.get_duration(path=req['path']):.2f}", flush=True)
                continue
            clip = req.get("voice") or None
            if clip and not os.path.exists(clip):
                raise RuntimeError("The voice file is missing")
            voice.speak(req["text"], req.get("lang") or "en", clip, req["out"])
            print(f"ok {n} {req['out']}", flush=True)
        except Exception as e:  # noqa: BLE001
            message = str(e).splitlines()[0] if str(e) else type(e).__name__
            print(f"err {n} {message}", flush=True)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "check":
        sys.exit(check())
    if cmd == "download" and len(sys.argv) > 2:
        sys.exit(download(sys.argv[2]))
    if cmd == "serve":
        serve()
        sys.exit(0)
    print(__doc__)
    sys.exit(2)
