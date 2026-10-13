// @vitest-environment jsdom

import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../../../api/gateway.ts";
import { loadSettings } from "../../../app/settings.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
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
let speechStarted = createDeferred();

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

class FakeAudio extends EventTarget {
  play = vi.fn(async () => {
    if (this.src.startsWith("blob:")) {
      speechStarted.resolve();
    }
  });
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn();
  constructor(readonly src: string) {
    super();
    audios.push(this);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  speechStarted = createDeferred();
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
      static override createObjectURL = vi.fn(() => "blob:synthetic-speech");
      static override revokeObjectURL = vi.fn();
    },
  );
});

afterEach(() => {
  for (const state of states.splice(0)) {
    stopChatRealtimeTalk(state);
  }
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
    for (const listener of listeners) {
      listener({ event, payload } as GatewayEventFrame);
    }
  };
  const request = createGatewayRequestMock(async (method, params) => {
    const payload = asOptionalRecord(params);
    if (method === "talk.config") {
      return {
        config: { talk: { provider, realtime: { mode: "stt-tts" }, silenceTimeoutMs: 100 } },
      };
    }
    if (method === "talk.session.create") {
      captureCount += 1;
      if (captureCount > 1) {
        nextCapture.resolve();
      }
      return {
        sessionId: `capture-${captureCount}`,
        audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
      };
    }
    if (method === "talk.session.close") {
      emit("talk.event", {
        transcriptionSessionId: payload?.sessionId,
        type: "transcript",
        text: "Tell me something local",
        final: true,
      });
      emit("talk.event", { transcriptionSessionId: payload?.sessionId, type: "close" });
      return { ok: true };
    }
    if (method === "chat.send") {
      runId = String(payload?.idempotencyKey);
      return { runId, status: "started" };
    }
    if (method === "talk.speak" || method === "tts.speak") {
      speech.resolve();
      return { audioBase64: "UklGRg==", mimeType: "audio/wav" };
    }
    if (method === "talk.session.appendAudio" || method === "chat.abort") {
      return { ok: true };
    }
    if (method === "agent.wait") {
      return { status: "ok" };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = createTestGatewayClient(request);
  client.addEventListener = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const state: ChatRealtimeState & ChatState = {
    client,
    connected: true,
    sessionKey: "agent:local:main",
    settings: loadSettings(),
    connectionEpoch: 0,
    chatHistoryPagination: { hasMore: false },
    chatLoading: false,
    chatMessages: [],
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    lastError: null,
    hello: null,
    ...createInitialChatRealtimeState(),
    requestUpdate: vi.fn(),
    resetRealtimeTalkConversation: vi.fn(),
    toggleRealtimeTalk: vi.fn(),
    toggleRealtimeTalkCamera: vi.fn(),
    switchRealtimeTalkCamera: vi.fn(),
  };
  attachChatRealtimeActions(
    state,
    () => permitted,
    (message, requestedRunId) => requestChatSend(state, { message, runId: requestedRunId }),
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
      if (method === "chat.send") {
        sent.resolve();
      }
      return result;
    });
    h.utterance();
    await sent.promise;
    expect(expectDefined(tracks[0], "captured microphone track").stop).toHaveBeenCalledOnce();
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
    await speechStarted.promise;
    expect(h.request).toHaveBeenCalledWith(provider ? "talk.speak" : "tts.speak", {
      text: "The local model answered.",
    });
    expect(audios).toHaveLength(1);
    expect(tracks).toHaveLength(1);
    expectDefined(audios[0], "speech playback").dispatchEvent(new Event("ended"));
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
    if (method === "chat.send") {
      sent.resolve();
    }
    return result;
  });
  h.utterance();
  await sent.promise;
  const runId = h.getRunId();
  h.emit("chat", { runId, state: "final" });
  await h.state.toggleRealtimeTalk();
  h.emit("chat", {
    runId,
    state: "final",
    message: { role: "assistant", content: [{ type: "text", text: "Too late" }] },
  });
  await Promise.resolve();
  expect(h.request).toHaveBeenCalledWith("chat.abort", { sessionKey: "agent:local:main", runId });
  expect(h.request.mock.calls.some(([method]) => method === "tts.speak")).toBe(false);
  expect(tracks).toHaveLength(1);
});

it("keeps listening for the model answer after an empty final", async () => {
  const h = harness();
  const sent = createDeferred();
  const impl = h.request.getMockImplementation()!;
  h.request.mockImplementation(async (method, params) => {
    const result = await impl(method, params);
    if (method === "chat.send") {
      sent.resolve();
    }
    return result;
  });
  await h.state.toggleRealtimeTalk();
  h.utterance();
  await sent.promise;
  const runId = h.getRunId();
  h.emit("chat", { runId, state: "final" });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.state.realtimeTalkStatus).toBe("thinking");
  expect(tracks).toHaveLength(1);
  expect(h.request).toHaveBeenCalledWith("agent.wait", { runId, timeoutMs: 120_000 });
  h.emit("chat", {
    runId,
    state: "final",
    message: { role: "assistant", content: [{ type: "text", text: "The delayed answer." }] },
  });
  await h.speech.promise;
  await speechStarted.promise;
  expect(h.request).toHaveBeenCalledWith("tts.speak", { text: "The delayed answer." });
  expect(h.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
});

it.each(["text before", "empty before", "text after"])(
  "waits for the model answer with an already-completed ACK (%s)",
  async (sequence) => {
    const h = harness();
    const sent = createDeferred();
    const impl = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (method, params) => {
      const result = await impl(method, params);
      if (method !== "chat.send") {
        return result;
      }
      if (sequence !== "text after") {
        h.emit("chat", {
          runId: h.getRunId(),
          state: "final",
          ...(sequence === "text before"
            ? {
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "Already answered." }],
                },
              }
            : {}),
        });
      }
      sent.resolve();
      return { runId: h.getRunId(), status: "ok" };
    });
    await h.state.toggleRealtimeTalk();
    h.utterance();
    await sent.promise;
    await vi.advanceTimersByTimeAsync(0);
    if (sequence !== "text before") {
      expect(h.state.realtimeTalkStatus).toBe("thinking");
      h.emit("chat", {
        runId: h.getRunId(),
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "Already answered." }] },
      });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(h.request).toHaveBeenCalledWith("tts.speak", { text: "Already answered." });
  },
);

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
    if (method === "chat.send") {
      sent.resolve();
    }
    return result;
  });
  await h.state.toggleRealtimeTalk();
  h.utterance();
  await closing.promise;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(h.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  expect(expectDefined(tracks[0], "captured microphone track").stop).toHaveBeenCalledOnce();
  finalized.resolve();
  await sent.promise;
  expect(h.request).toHaveBeenCalledWith(
    "chat.send",
    expect.objectContaining({ message: "Tell me something local" }),
    { timeoutMs: 30_000 },
  );
  await h.state.toggleRealtimeTalk();
});

it("discards buffered STT when Stop interrupts finalization instead of sending a chat turn", async () => {
  const h = harness();
  const closing = createDeferred();
  const release = createDeferred();
  const settled = createDeferred();
  const implementation = expectDefined(h.request.getMockImplementation(), "Gateway fixture");
  h.request.mockImplementation(async (method, params) => {
    if (method === "talk.session.close") {
      if (asOptionalRecord(params)?.discard === true) {
        return { ok: true };
      }
      closing.resolve();
      await release.promise;
    }
    const result = await implementation(method, params);
    if (method === "talk.session.close") {
      settled.resolve();
    }
    return result;
  });
  await h.state.toggleRealtimeTalk();
  h.utterance();
  await closing.promise;
  try {
    await h.state.toggleRealtimeTalk();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request).toHaveBeenCalledWith(
      "talk.session.close",
      { sessionId: "capture-1", discard: true },
      { timeoutMs: null },
    );
  } finally {
    release.resolve();
    await settled.promise;
  }
  expect(h.state.realtimeTalkStatus).toBe("idle");
  expect(h.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  expect(h.request.mock.calls.some(([method]) => method === "tts.speak")).toBe(false);
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
    if (h.state.realtimeTalkStatus === "error") {
      rejected.resolve();
    }
  };
  const impl = h.request.getMockImplementation()!;
  h.request.mockImplementation(async (method, params) => {
    const result = await impl(method, params);
    return method === "chat.send" ? { runId: h.getRunId(), status: "error" } : result;
  });
  await h.state.toggleRealtimeTalk();
  h.utterance();
  await rejected.promise;
  expect(h.state.realtimeTalkDetail).toBe(
    "The voice reply was interrupted. Start Talk again to retry.",
  );
  expect(h.request.mock.calls.some(([method]) => method === "chat.send")).toBe(true);
  expect(h.request.mock.calls.some(([method]) => method === "tts.speak")).toBe(false);
  expect(tracks).toHaveLength(1);
});
