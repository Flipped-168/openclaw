import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { RealtimeTranscriptionSessionCallbacks } from "../../realtime-transcription/provider-types.js";
import { mulawToPcm } from "../../talk/audio-codec.js";

export type TalkFileTranscriptionConfig = {
  cfg: OpenClawConfig;
  maxBytes: number;
  provider?: string;
  providers: Array<{ id: string; models: string[] }>;
};

/** Explicit file models use the same selection and input budget as uploaded voice notes. */
export async function resolveTalkFileTranscriptionConfig(
  cfg: OpenClawConfig,
): Promise<TalkFileTranscriptionConfig | undefined> {
  if (!cfg.tools?.media?.models?.length || cfg.tools.media.audio?.enabled === false) {
    return undefined;
  }
  const [{ buildMediaUnderstandingRegistry, normalizeMediaProviderId }, { resolveModelEntries }] =
    await Promise.all([
      import("../../media-understanding/provider-registry.js"),
      import("../../media-understanding/resolve.js"),
    ]);
  const registry = buildMediaUnderstandingRegistry(undefined, cfg);
  const entries = resolveModelEntries({
    cfg,
    capability: "audio",
    config: cfg.tools.media.audio,
    providerRegistry: registry,
  });
  if (entries.length === 0) {
    return undefined;
  }
  const providers = new Map<string, string[]>();
  const providerId = (id: string) => registry.get(normalizeMediaProviderId(id))?.id ?? id;
  for (const { entry } of entries) {
    if (!entry.provider) {
      continue;
    }
    const id = providerId(entry.provider);
    const models = providers.get(id) ?? [];
    if (entry.model && !models.includes(entry.model)) {
      models.push(entry.model);
    }
    providers.set(id, models);
  }
  const { resolveAudioInputBudget } = await import("../../media-understanding/runtime.js");
  const budget = await resolveAudioInputBudget({ cfg });
  return budget.enabled
    ? {
        cfg,
        maxBytes: budget.maxBytes,
        provider: entries[0]?.entry.provider ? providerId(entries[0].entry.provider) : undefined,
        providers: Array.from(providers, ([id, models]) => ({ id, models })),
      }
    : undefined;
}

function encodeWav(audio: Buffer): Buffer {
  const pcm = mulawToPcm(audio);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Adapts the browser's existing audio frames to the file-transcription owner. */
export function createTalkFileTranscriptionSession(
  config: TalkFileTranscriptionConfig,
  callbacks: RealtimeTranscriptionSessionCallbacks,
  assertCurrent: () => void,
) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let closed = false;
  return {
    connect: () => Promise.resolve(),
    sendAudio(audio: Buffer) {
      if (closed) {
        throw new Error("Transcription session is closed");
      }
      if ((bytes + audio.length) * 2 + 44 > config.maxBytes) {
        throw new Error(`Transcription audio exceeds the configured ${config.maxBytes} byte limit`);
      }
      chunks.push(audio);
      bytes += audio.length;
    },
    close() {
      closed = true;
      chunks.length = 0;
      bytes = 0;
    },
    async finish() {
      if (closed || bytes === 0) {
        return;
      }
      const audio = Buffer.concat(chunks, bytes);
      chunks.length = 0;
      bytes = 0;
      const root = resolvePreferredOpenClawTmpDir();
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await fs.mkdtemp(path.join(root, "talk-stt-"));
      try {
        const filePath = path.join(directory, "speech.wav");
        await fs.writeFile(filePath, encodeWav(audio), { mode: 0o600 });
        const { transcribeAudioFile } = await import("../../media-understanding/runtime.js");
        if (closed) {
          return;
        }
        assertCurrent();
        const result = await transcribeAudioFile({ cfg: config.cfg, filePath, mime: "audio/wav" });
        if (!closed) {
          assertCurrent();
          callbacks.onTranscript?.(result.text ?? "");
        }
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  };
}
