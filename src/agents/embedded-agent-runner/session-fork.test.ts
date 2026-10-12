import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import type { StreamFn } from "../runtime/index.js";
import { runEmbeddedSessionFork, wrapStreamFnWithSessionFork } from "./session-fork.js";

const context: Context = {
  systemPrompt: "Stable instructions",
  messages: [{ role: "user", content: "Parent question", timestamp: 1 }],
};
const model: Model = {
  provider: "openai",
  id: "fork-test",
  name: "Fork test",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 10000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const identity = { agentId: "main", sessionId: "fork-test" };

function transport(payloads: Record<string, unknown>[], tools: unknown[]): StreamFn {
  return async (requestModel, requestContext, options) => {
    const key = requestModel.api === "anthropic-messages" ? "messages" : "input";
    const payload = {
      model: requestModel.id,
      system: requestContext.systemPrompt,
      tools,
      [key]: requestContext.messages.map((message) => structuredClone(message)),
    };
    const prepared = (await options?.onPayload?.(payload, requestModel)) ?? payload;
    if (!isRecord(prepared)) {
      throw new Error("Expected provider request");
    }
    payloads.push(prepared);
    const stream = createAssistantMessageEventStream();
    stream.end({
      role: "assistant",
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      content: [{ type: "text", text: "Answer" }],
      stopReason: "stop",
      timestamp: 2,
      usage: {
        input: 10,
        output: 1,
        cacheRead: 9,
        cacheWrite: 0,
        totalTokens: 11,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    return stream;
  };
}

async function fork(requestModel = model) {
  return runEmbeddedSessionFork({
    ...identity,
    model: requestModel,
    question: "Review only",
    assertCurrent: () => {},
  });
}

afterEach(() => cleanupSessionResources());

describe("prepared session fork provider boundary", () => {
  it.each([
    { api: "openai-responses" as const, tools: [{ type: "web_search" }], choice: "none" },
    {
      api: "anthropic-messages" as const,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      choice: { type: "none" },
    },
  ])("disables hosted tools while retaining the $api prefix", async ({ api, tools, choice }) => {
    const requestModel = { ...model, api };
    const payloads: Record<string, unknown>[] = [];
    const parent = wrapStreamFnWithSessionFork(transport(payloads, tools), identity);
    await (await parent(requestModel, context, {})).result();
    const original = structuredClone(payloads[0]);
    await expect(fork(requestModel)).resolves.toBe("Answer");
    expect(payloads[1]?.tool_choice).toEqual(choice);
    expect(payloads[1]?.tools).toEqual(original?.tools);
    expect(payloads[1]?.system).toEqual(original?.system);
    const key = api === "anthropic-messages" ? "messages" : "input";
    expect(payloads[1]?.[key]).toEqual([
      ...context.messages,
      { role: "user", content: "Review only", timestamp: expect.any(Number) },
    ]);
    expect(payloads[0]).toEqual(original);
  });

  it("does not re-enter the parent's one-shot prepared payload hook", async () => {
    const payloads: Record<string, unknown>[] = [];
    const onPayload = vi.fn((payload: unknown) => {
      if (onPayload.mock.calls.length > 1) {
        throw new Error("Provider review continuation cannot rebuild or retry its request");
      }
      if (!isRecord(payload)) {
        throw new Error("Expected request");
      }
      return { ...payload, client_metadata: { acknowledged: "review" } };
    });
    const parent = wrapStreamFnWithSessionFork(transport(payloads, []), identity);
    await (await parent(model, context, { onPayload })).result();
    await expect(fork()).resolves.toBe("Answer");
    expect(onPayload).toHaveBeenCalledTimes(1);
    expect(payloads[1]?.client_metadata).toEqual({ acknowledged: "review" });
  });
});
