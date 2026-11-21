import type { ChatterboxGpu } from "@codeden/contracts";
import type { PinnedFile } from "../local/catalog";

/**
 * What the Chatterbox install fetches (§11.3). `uv` is pinned by size and SHA-256 and sets up
 * the rest: a Python 3.12 of its own, a virtual environment, PyTorch for the graphics card
 * (NVIDIA's CUDA build or AMD's ROCm build for Windows), Chatterbox and what it needs. The
 * models come from Hugging Face on first install (`chatterbox_tts.py download`).
 */

export const UV_VERSION = "0.13.7";

/** `uv` for Windows, by `process.arch`. */
export const UV_PINS: Record<string, PinnedFile> = {
  x64: {
    url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`,
    sha256: "0cdc5b38fe5a8168ed6a25814f5ba43c21d313dd3187314fccb37b7cec46e021",
    bytes: 15_236_317,
  },
  arm64: {
    url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-pc-windows-msvc.zip`,
    sha256: "505d9e65e7692bac3ddf98c66754aa26c5050c409c184af30a881a0a72cc85e3",
    bytes: 15_538_425,
  },
};

/** AMD's PyTorch wheels and Chatterbox need this Python. */
export const PYTHON_VERSION = "3.12";

const ROCM = "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1";

/** PyTorch for each card: `uv pip install` arguments, and the pins that keep it in place. */
export const TORCH: Record<
  ChatterboxGpu,
  { label: string; install: string[]; constraints: string[] }
> = {
  nvidia: {
    label: "PyTorch for NVIDIA (about 3 GB)",
    install: [
      "torch==2.9.1",
      "torchaudio==2.9.1",
      "--index-url",
      "https://download.pytorch.org/whl/cu128",
    ],
    constraints: ["torch==2.9.1", "torchaudio==2.9.1"],
  },
  amd: {
    label: "PyTorch for AMD (about 3 GB)",
    install: [
      `${ROCM}/rocm_sdk_core-7.2.1-py3-none-win_amd64.whl`,
      `${ROCM}/rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl`,
      `${ROCM}/rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl`,
      `${ROCM}/rocm-7.2.1.tar.gz`,
      `${ROCM}/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl`,
      `${ROCM}/torchaudio-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl`,
    ],
    constraints: ["torch==2.9.1+rocm7.2.1", "torchaudio==2.9.1+rocm7.2.1"],
  },
};

/** Chatterbox itself, installed without its own PyTorch pin (it would replace the card's build). */
export const CHATTERBOX_PACKAGE = "chatterbox-tts==0.1.7";

/** What Chatterbox 0.1.7 needs, without PyTorch and its demo-only packages. */
export const CHATTERBOX_REQUIREMENTS = [
  "numpy>=1.24.0,<2.0.0",
  "librosa==0.11.0",
  "s3tokenizer",
  "transformers==5.2.0",
  "diffusers==0.29.0",
  "resemble-perth>=1.0.0",
  "conformer==0.3.2",
  "safetensors==0.5.3",
  "spacy-pkuseg",
  "pykakasi==2.3.0",
  "pyloudnorm",
  "omegaconf",
  "silero-vad==6.2.3",
  "soundfile",
  "accelerate",
  "huggingface_hub",
  // The watermark library still imports pkg_resources.
  "setuptools<81",
];

/** What each model download is called in the install's progress. */
export const MODEL_LABELS = {
  turbo: "Downloading Chatterbox Turbo (about 2 GB)",
  multilingual: "Downloading Chatterbox Multilingual (about 3 GB)",
} as const;
