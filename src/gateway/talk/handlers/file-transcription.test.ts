import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { AudioTranscriptionRequest } from "../../../media-understanding/types.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import { cleanupTalkConnection } from "../session-registry.js";
import { createTalkHandlerCaller } from "./handler-invocation.test-support.js";
import { expectRespondError, expectRespondOk } from "./responses.test-support.js";
import { talkSessionHandlers } from "./session.js";

const cfg: OpenClawConfig = {
  tools: {
    media: {
      audio: { enabled: true, maxBytes: 8192 },
      models: [{ provider: "local-stt", model: "whisper", capabilities: ["audio"] }],
    },
  },
};

function withFileProvider(
  run: (requests: AudioTranscriptionRequest[]) => Promise<void>,
  beforeTranscription?: () => Promise<void>,
) {
  const requests: AudioTranscriptionRequest[] = [];
  const registry = createEmptyPluginRegistry();
  registry.mediaUnderstandingProviders.push({
    pluginId: "local-stt",
    source: "test",
    provider: {
      id: "local-stt",
      capabilities: ["audio"],
      resolveAuth: () => ({ kind: "none", source: "synthetic local provider" }),
      transcribeAudio: async (request) => {
        requests.push(request);
        await beforeTranscription?.();
        return { text: "Turn the lights on", model: request.model };
      },
    },
  });
  return withPluginRuntimeGenerationScope(
    {
      pluginRegistry: registry,
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [{ id: "local-stt", contracts: { mediaUnderstandingProviders: ["local-stt"] } }],
      }),
    },
    () => run(requests),
  );
}

describe("configured file transcription through Talk RPCs", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanupTalkConnection("conn-1", { warn: vi.fn() });
  });

  it("transcribes captured browser audio with the configured media model", async () => {
    const transcribing = createDeferred();
    const release = createDeferred();
    onTestFinished(() => release.resolve());
    await withFileProvider(
      async (requests) => {
        const call = createTalkHandlerCaller(talkSessionHandlers);
        const events: Array<{ type?: string; text?: string }> = [];
        const context = {
          getRuntimeConfig: () => cfg,
          broadcastToConnIds: (_event: string, payload: { type?: string; text?: string }) =>
            events.push(payload),
          logGateway: { warn: vi.fn() },
        };
        const respond = vi.fn();
        await call("talk.session.create", {
          params: { mode: "transcription", transport: "gateway-relay", brain: "none" },
          respond,
          context,
        });
        const session = expectRespondOk(respond, { provider: "local-stt", mode: "transcription" });
        const sessionId = (session as { sessionId: string }).sessionId;
        await call("talk.session.appendAudio", {
          params: { sessionId, audioBase64: Buffer.alloc(1600, 0xff).toString("base64") },
          respond: vi.fn(),
          context,
        });
        expect(requests).toHaveLength(0);
        const closed = vi.fn();
        const closing = call("talk.session.close", {
          params: { sessionId },
          respond: closed,
          context,
        });
        await awaitGateBeforeSettlement(
          transcribing.promise,
          closing,
          "close settled before transcription",
        );
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(6000);
        expect(closed).not.toHaveBeenCalled();
        expect(events.some((event) => event.type === "close")).toBe(false);
        release.resolve();
        await closing;
        vi.useRealTimers();
        expectRespondOk(closed);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.model).toBe("whisper");
        const audio = requests[0]?.buffer;
        expect(audio?.subarray(0, 4).toString()).toBe("RIFF");
        expect(audio?.readUInt32LE(24)).toBe(8000);
        expect(audio?.readUInt16LE(34)).toBe(16);
        expect(audio?.subarray(44)).toEqual(Buffer.alloc(3200));
        expect(events).toContainEqual(
          expect.objectContaining({ type: "transcript", text: "Turn the lights on" }),
        );
        expect(events.at(-1)?.type).toBe("close");
        cleanupTalkConnection("conn-1", context.logGateway);
      },
      async () => {
        transcribing.resolve();
        await release.promise;
      },
    );
  });

  it("rejects oversized captures before dispatching them to the media provider", async () => {
    await withFileProvider(async (requests) => {
      const call = createTalkHandlerCaller(talkSessionHandlers);
      const context = {
        getRuntimeConfig: () => cfg,
        broadcastToConnIds: vi.fn(),
        logGateway: { warn: vi.fn() },
      };
      const created = vi.fn();
      await call("talk.session.create", {
        params: { mode: "transcription" },
        respond: created,
        context,
      });
      const sessionId = (expectRespondOk(created) as { sessionId: string }).sessionId;
      const rejected = vi.fn();
      await call("talk.session.appendAudio", {
        params: { sessionId, audioBase64: Buffer.alloc(4096, 0xff).toString("base64") },
        respond: rejected,
        context,
      });
      expectRespondError(rejected, { message: expect.stringContaining("8192 byte limit") });
      expect(requests).toHaveLength(0);
      cleanupTalkConnection("conn-1", context.logGateway);
    });
  });

  it.each([
    { name: "explicit provider", params: { provider: "streaming-only" }, streaming: false },
    { name: "explicit model", params: { model: "streaming-model" }, streaming: false },
    { name: "configured streaming", params: {}, streaming: true },
    { name: "no configured audio models", params: {}, streaming: false, unconfigured: true },
  ])(
    "preserves $name selection instead of falling back to file audio",
    async ({ params, streaming, unconfigured }) => {
      await withFileProvider(async (requests) => {
        const config: OpenClawConfig = {
          ...(unconfigured ? {} : cfg),
          ...(streaming
            ? {
                plugins: {
                  entries: {
                    "voice-call": { config: { streaming: { provider: "streaming-only" } } },
                  },
                },
              }
            : {}),
        };
        const responded = vi.fn();
        await createTalkHandlerCaller(talkSessionHandlers)("talk.session.create", {
          params: { mode: "transcription", ...params },
          respond: responded,
          config,
        });
        expectRespondError(responded, {
          message: expect.stringContaining("transcription provider"),
        });
        expect(requests).toHaveLength(0);
      });
    },
  );

  it("discards buffered audio when its connection closes before transcription starts", async () => {
    await withFileProvider(async (requests) => {
      const call = createTalkHandlerCaller(talkSessionHandlers);
      const context = {
        getRuntimeConfig: () => cfg,
        broadcastToConnIds: vi.fn(),
        logGateway: { warn: vi.fn() },
      };
      const created = vi.fn();
      await call("talk.session.create", {
        params: { mode: "transcription" },
        respond: created,
        context,
      });
      const sessionId = (expectRespondOk(created) as { sessionId: string }).sessionId;
      await call("talk.session.appendAudio", {
        params: { sessionId, audioBase64: Buffer.alloc(1600, 0xff).toString("base64") },
        respond: vi.fn(),
        context,
      });
      const closing = call("talk.session.close", {
        params: { sessionId },
        respond: vi.fn(),
        context,
      });
      cleanupTalkConnection("conn-1", context.logGateway);
      await closing;
      expect(requests).toHaveLength(0);
    });
  });

  it("reports provider failures as a Talk error before closing the session", async () => {
    await withFileProvider(
      async () => {
        const call = createTalkHandlerCaller(talkSessionHandlers);
        const events: Array<{ type?: string; message?: string }> = [];
        const context = {
          getRuntimeConfig: () => cfg,
          broadcastToConnIds: (_event: string, payload: { type?: string; message?: string }) =>
            events.push(payload),
          logGateway: { warn: vi.fn() },
        };
        const created = vi.fn();
        await call("talk.session.create", {
          params: { mode: "transcription" },
          respond: created,
          context,
        });
        const sessionId = (expectRespondOk(created) as { sessionId: string }).sessionId;
        await call("talk.session.appendAudio", {
          params: { sessionId, audioBase64: Buffer.alloc(1600, 0xff).toString("base64") },
          respond: vi.fn(),
          context,
        });
        const closed = vi.fn();
        await call("talk.session.close", { params: { sessionId }, respond: closed, context });
        expectRespondError(closed, {
          message: expect.stringContaining("Local speech endpoint rejected audio"),
        });
        expect(events.at(-2)).toMatchObject({
          type: "error",
          message: expect.stringContaining("Local speech endpoint rejected audio"),
        });
        expect(events.at(-1)?.type).toBe("close");
      },
      async () => {
        throw new Error("Local speech endpoint rejected audio");
      },
    );
  });
});
