import type { WhisperModelId } from "@codeden/contracts";

/**
 * What local Whisper downloads (§11.3), pinned by size and SHA-256 so a download is only
 * used when it is byte-for-byte the file CodeDen was tested with.
 *
 * - **Runtime:** whisper.cpp built as a Node-API addon, one prebuilt `index.node` per
 *   platform, published to the npm registry as `@fugood/node-whisper-<platform>-<arch>`
 *   (MIT). CodeDen fetches the package tarball over HTTPS and extracts the addon itself, so
 *   no npm, compiler or system Node.js is needed, and Node-API keeps it loadable from any
 *   Node or Electron version.
 * - **Models:** the whisper.cpp GGML models from Hugging Face (MIT), at a fixed revision.
 *   The 5-bit quantised (`q5_1`) files are about 40% the size of the full ones with nearly
 *   the same accuracy.
 */

/** One pinned download. */
export interface PinnedFile {
  url: string;
  sha256: string;
  bytes: number;
}

/** The runtime archive for one platform; `entry` is the addon inside the tarball. */
export interface RuntimePin extends PinnedFile {
  version: string;
  entry: string;
  /** A graphics card build (`vulkan`); none for the processor build. */
  variant?: "vulkan";
}

export interface ModelPin extends PinnedFile {
  id: WhisperModelId;
  /** File name in `<home>/models/whisper/`. */
  file: string;
  label: string;
  hint: string;
  englishOnly: boolean;
  recommended: boolean;
}

export const WHISPER_RUNTIME_VERSION = "1.1.3";

const runtime = (target: string, sha256: string, bytes: number): RuntimePin => ({
  version: WHISPER_RUNTIME_VERSION,
  url: `https://registry.npmjs.org/@fugood/node-whisper-${target}/-/node-whisper-${target}-${WHISPER_RUNTIME_VERSION}.tgz`,
  sha256,
  bytes,
  entry: "package/index.node",
});

/** Prebuilt runtimes by `process.platform-process.arch`. */
export const RUNTIME_PINS: Record<string, RuntimePin> = {
  "win32-x64": runtime(
    "win32-x64",
    "25d54aff191d51833a4941ed77d54beeef034fad585c485938fb34e59f32cb4a",
    1_205_460,
  ),
  "win32-arm64": runtime(
    "win32-arm64",
    "c6e36608d32aaec62e6f07bdfd7a29576c12b0eb2cf396bed6f6b5ee236a1342",
    1_226_903,
  ),
  "darwin-x64": runtime(
    "darwin-x64",
    "8f9af3930e94f7b4123cc39ae8fea2554477404e65d4d5ad6a0ca142a6add591",
    1_642_873,
  ),
  "darwin-arm64": runtime(
    "darwin-arm64",
    "cb54d7e9050a896d794193367769b0c93e77c51e34861d521140c2dd8cc501dc",
    1_516_419,
  ),
  "linux-x64": runtime(
    "linux-x64",
    "d847231487492e4bcaef2d6d47e06e4b4ea872ee621fc988d01b7f0733006224",
    1_279_405,
  ),
  "linux-arm64": runtime(
    "linux-arm64",
    "f392eacef6c773442e5c427a6dca5ab6cd3f4f104ca8d609c27c7cf97e6e2a4a",
    1_199_206,
  ),
};

/**
 * Graphics card builds by platform: whisper.cpp with Vulkan, which runs on NVIDIA, AMD Radeon
 * and other cards through the normal graphics driver. Used when a supported card is found;
 * the processor build above is the fallback.
 */
export const GPU_RUNTIME_PINS: Record<string, RuntimePin> = {
  "win32-x64": {
    version: WHISPER_RUNTIME_VERSION,
    url: `https://registry.npmjs.org/@fugood/node-whisper-win32-x64-vulkan/-/node-whisper-win32-x64-vulkan-${WHISPER_RUNTIME_VERSION}.tgz`,
    sha256: "9ade1c7a94555693ec4de553aca29c47c99965eebe44924a317f509b30e37562",
    bytes: 12_950_211,
    entry: "package/index.node",
    variant: "vulkan",
  },
};

/** Hugging Face revision of `ggerganov/whisper.cpp` the checksums below belong to. */
const MODEL_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";

/**
 * The model offered: large-v3-turbo, 5-bit quantised (`q5_0`). The smaller models (tiny, base,
 * small) mistook Dutch for English and made up sentences far too often to be worth offering.
 * Older settings that name one of them use this one.
 */
export const MODEL_PINS: ModelPin[] = [
  {
    id: "large-v3-turbo",
    file: "ggml-large-v3-turbo-q5_0.bin",
    url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}/ggml-large-v3-turbo-q5_0.bin`,
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    bytes: 574_041_195,
    englishOnly: false,
    label: "Large v3 Turbo",
    hint: "Accurate in many languages; fast on a graphics card",
    recommended: true,
  },
];

/** `win32-x64` style key for the current process. */
export function currentPlatform(): string {
  return `${process.platform}-${process.arch}`;
}
