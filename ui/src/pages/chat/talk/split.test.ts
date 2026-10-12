// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../../../api/gateway.ts";
import { loadSettings } from "../../../app/settings.ts";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import {
  attachChatRealtimeActions,
  createInitialChatRealtimeState,
  stopChatRealtimeTalk,
  type ChatRealtimeState,
} from "../chat-realtime.ts";
import { requestChatSend } from "../chat-send-request.ts";
import type { ChatState } from "../chat-state-contract.ts";

type AudioProcessor = {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
};
const processors: AudioProcessor[] = [];
const tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
const audios: FakeAudio[] = [];
const states: ChatRealtimeState[] = [];
let audioCreated = createDeferred();

class FakeAudioContext {
  readonly sampleRate = 8000;
  readonly destination = {};
  close = vi.fn(async () => undefined);
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  createScriptProcessor() {
    const processor = { onaudioprocess: null, connect() {}, disconnect() {} };
    processors.push(processor);
    return processor;
  }
  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0),
      disconnect() {},
    };
  }
}

class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn();
  constructor(readonly src: string) {
    audios.push(this);
    audioCreated.resolve();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  audioCreated = createDeferred();
  processors.length = tracks.length = audios.length = 0;
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => {
        const track = Object.assign(new EventTarget(), { stop: vi.fn() });
        tracks.push(track);
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      }),
    },
  });
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:synthetic-speech");
      static revokeObjectURL = vi.fn();
    },
  );
});

afterEach(() => {
  for (const state of states.splice(0)) stopChatRealtimeTalk(state);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function harness(provider?: string) {
  const listeners = new Set<(event: GatewayEventFrame) => void>();
  const speech = createDeferred();
  const nextCapture = createDeferred();
  let captureCount = 0;
  let runId = "";
  let permitted = true;
  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners) listener({ event, payload } as GatewayEventFrame);
  };
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "talk.config")
      return {
        config: { talk: { provider, realtime: { mode: "stt-tts" }, silenceTimeoutMs: 100 } },
      };
    if (method === "talk.session.create") {
      captureCount += 1;
      if (captureCount > 1) nextCapture.resolve();
      return {
        sessionId: `capture-${captureCount}`,
        audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
      };
    }
    if (method === "talk.session.close") {
      emit("talk.event", {
        transcriptionSessionId: params?.sessionId,
        type: "transcript",
        text: "Tell me something local",
        final: true,
      });
      emit("talk.event", { transcriptionSessionId: params?.sessionId, type: "close" });
      return { ok: true };
    }
    if (method === "chat.send") {
      runId = String(params?.idempotencyKey);
      return { runId, status: "started" };
    }
    if (method === "talk.speak" || method === "tts.speak") {
      speech.resolve();
      return { audioBase64: "UklGRg==", mimeType: "audio/wav" };
    }
    if (method === "talk.session.appendAudio" || method === "chat.abort") return { ok: true };
    throw new Error(`Unexpected request: ${method}`);
  });
  const state = {
    client: {
      request,
      addEventListener: (listener: (event: GatewayEventFrame) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    connected: true,
    sessionKey: "agent:local:main",
    settings: loadSettings(),
    ...createInitialChatRealtimeState(),
    requestUpdate: vi.fn(),
  } as unknown as ChatRealtimeState;
  attachChatRealtimeActions(
    state,
    () => permitted,
    (message, runId) => requestChatSend(state as ChatState, { message, runId }),
  );
  states.push(state);
  const utterance = () => {
    const processor = processors.at(-1)!;
    const feed = (value: number) =>
      processor.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(800).fill(value) },
      });
    feed(0.2);
    feed(0);
  };
  return {
    state,
    request,
    utterance,
    emit,
    speech,
    nextCapture,
    getRunId: () => runId,
    requireReview: () => {
      permitted = false;
    },
  };
}

it.each(["openai", undefined])(
  "routes configured split Talk through STT, chat and Gateway speech (provider: %s)",
  async (provider) => {
    const h = harness(provider);
    await h.state.toggleRealtimeTalk();
    expect(h.state.realtimeTalkStatus).toBe("listening");
    const sent = createDeferred();
    const impl = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (method, params) => {
      const result = await impl(method, params);
      if (method === "chat.send") sent.resolve();
      return result;
    });
    h.utterance();
    await sent.promise;
    expect(tracks[0].stop).toHaveBeenCalledOnce();
    expect(h.request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "agent:local:main",
        message: "Tell me something local",
      }),
      { timeoutMs: 30_000 },
    );
    h.emit("chat", {
      runId: "unrelated",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "Wrong answer" }] },
    });
    h.emit("chat", {
      runId: h.getRunId(),
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The local model answered." }],
      },
    });
    await h.speech.promise;
    await audioCreated.promise;
    expect(h.request).toHaveBeenCalledWith(provider ? "talk.speak" : "tts.speak", {
      text: "The local model answered.",
    });
    expect(audios).toHaveLength(1);
    expect(tracks).toHaveLength(1);
    audios[0].onended?.();
    await h.nextCapture.promise;
    expect(h.state.realtimeTalkConversationState.entries).toEqual([]);
    await h.state.toggleRealtimeTalk();
  },
);

it("stopping during the model response aborts the owned run and ignores late output", async () => {
  const h = harness();
  await h.state.toggleRealtimeTalk();
  const sent = createDeferred();
  const impl = h.request.getMockImplementation()!;
  h.request.mockImplementation(async (method, params) => {
    const result = await impl(method, params);
    if (method === "chat.send") sent.resolve();
    return result;
  });
  h.utterance();
  await sent.promise;
  const runId = h.getRunId();
  await h.state.toggleRealtimeTalk();
  h.emit("chat", {
    runId,
    state: "final",
    message: { role: "assistant", content: [{ type: "text", text: "Too late" }] },
  });
  await Promise.resolve();
  expect(h.request).toHaveBeenCalledWith("chat.abort", { sessionKey: "agent:local:main", runId });
  expect(audios).toHaveLength(0);
  expect(tracks).toHaveLength(1);
});

it("waits for buffered local STT to finish instead of dropping a slow final transcript", async () => {
  const h = harness();
  const closing = createDeferred();
  const finalized = createDeferred();
  const sent = createDeferred();
  const impl = h.request.getMockImplementation()!;
  h.request.mockImplementation(async (method, params) => {
    if (method === "talk.session.close") {
      closing.resolve();
      await finalized.promise;
    }
    const result = await impl(method, params);
    if (method === "chat.send") sent.resolve();
    return result;
  });
  await h.state.toggleRealtimeTalk();
  h.utterance();
  await closing.promise;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(h.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  expect(tracks[0].stop).toHaveBeenCalledOnce();
  finalized.resolve();
  await sent.promise;
  expect(h.request).toHaveBeenCalledWith(
    "chat.send",
    expect.objectContaining({ message: "Tell me something local" }),
    { timeoutMs: 30_000 },
  );
  await h.state.toggleRealtimeTalk();
});

it.each(["stop", "provider review"])(
  "cancels pending configuration on %s without acquiring the microphone",
  async (reason) => {
    const h = harness();
    const configuration = createDeferred<Awaited<ReturnType<typeof h.request>>>();
    h.request.mockImplementationOnce(async () => configuration.promise);
    const starting = h.state.toggleRealtimeTalk();
    if (reason === "stop") {
      await h.state.toggleRealtimeTalk();
    } else {
      h.requireReview();
    }
    configuration.resolve({
      config: {
        talk: { provider: undefined, silenceTimeoutMs: 100, realtime: { mode: "stt-tts" } },
      },
    });
    await starting;
    expect(tracks).toHaveLength(0);
    expect(h.state.realtimeTalkStatus).toBe("idle");
  },
);

it("surfaces a rejected chat admission instead of waiting forever for a model reply", async () => {
  const h = harness();
  const rejected = createDeferred();
  h.state.requestUpdate = () => {
    if (h.state.realtimeTalkStatus === "error") rejected.resolve();
  };
  const impl = h.request.getMockImplementation()!;
  h.request.mockImplementation(async (method, params) => {
    const result = await impl(method, params);
    return method === "chat.send" ? { ...result, status: "error" } : result;
  });
  await h.state.toggleRealtimeTalk();
  h.utterance();
  await rejected.promise;
  expect(h.state.realtimeTalkDetail).toBe(
    "The voice reply was interrupted. Start Talk again to retry.",
  );
  expect(h.request.mock.calls.some(([method]) => method === "chat.send")).toBe(true);
  expect(audios).toHaveLength(0);
  expect(tracks).toHaveLength(1);
});
