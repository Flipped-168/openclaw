import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput, type TerminalInput } from "./terminal-resolution.test-support.js";
import { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

// mock-isolation: terminal recovery must not update persistent auth-profile state.
vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

const REJECTED_TOOL_CALL_MESSAGE = "Provider returned an incomplete or malformed tool call";

// The reported turn: an exec call completed, then the provider streamed a second
// call whose arguments were not valid JSON. The transport removed that call
// before dispatch and ended the turn with stopReason=error.
function rejectedCallAfterSettledTool(
  overrides: Parameters<typeof makeEmbeddedRunnerAttempt>[0] = {},
  assistantOverrides: Parameters<typeof buildEmbeddedRunnerAssistant>[0] = {},
) {
  const assistant = buildEmbeddedRunnerAssistant({
    api: "openai-completions",
    provider: "meterkey",
    model: "deepseek/deepseek-v4-flash",
    stopReason: "error",
    errorMessage: REJECTED_TOOL_CALL_MESSAGE,
    content: [],
    ...assistantOverrides,
  });
  const attempt = makeEmbeddedRunnerAttempt({
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    toolMetas: [{ toolName: "exec", toolCallId: "call_exec", meta: "git log" }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    ...overrides,
  });
  return {
    attempt,
    attemptAssistant: assistant,
    activeErrorContext: { provider: "meterkey", model: "deepseek/deepseek-v4-flash" },
    modelApi: "openai-completions",
    payloadsWithToolMedia: buildEmbeddedRunPayloads({
      assistantTexts: attempt.assistantTexts,
      lastAssistant: assistant,
      currentAssistant: assistant,
      sessionKey: "session:rejected-tool-call",
    }),
  } satisfies Partial<TerminalInput>;
}

function refusedExecThenRejectedCall() {
  const turn = rejectedCallAfterSettledTool(
    {
      lastToolError: { toolName: "exec", executionStarted: false, mutatingAction: false },
      toolMetas: [{ toolName: "exec", toolCallId: "call_exec", isError: true }],
    },
    {
      api: "anthropic-messages",
      provider: "anthropic",
      errorCode: "malformed_tool_call_arguments",
      errorMessage: "Provider completed tool call with malformed JSON arguments",
    },
  );
  turn.attempt.messagesSnapshot = [
    { role: "user", content: "Inspect the workspace", timestamp: 0 },
    buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "call_exec", name: "exec", arguments: {} }],
    }),
    {
      role: "toolResult",
      toolCallId: "call_exec",
      toolName: "exec",
      content: [{ type: "text", text: "exec preflight: complex interpreter invocation detected" }],
      isError: true,
      timestamp: 0,
    },
    turn.attemptAssistant,
  ];
  return { ...turn, modelApi: "anthropic-messages" };
}

describe("terminal resolution for a tool call rejected before dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("continues once after settled tools instead of replaying the attempt", async () => {
    const turn = rejectedCallAfterSettledTool();
    // The completed exec makes the attempt unsafe to replay.
    expect(turn.attempt.replayMetadata.hadPotentialSideEffects).toBe(true);
    const activateInternalPrompt = vi.fn();

    await expect(
      resolveEmbeddedRunTerminal(
        makeTerminalInput({ ...turn, sessionPromptState: { activateInternalPrompt } }),
      ),
    ).resolves.toEqual({ action: "retry" });
    expect(activateInternalPrompt).toHaveBeenCalledOnce();
    const instruction = activateInternalPrompt.mock.calls[0]?.[0] as string;
    expect(instruction).toContain("rejected before it ran");
    expect(instruction).toContain("Do not repeat completed tool calls");

    const exhausted = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        ...turn,
        retryState: { ...createEmbeddedRunTerminalRetryState(), emptyResponseAttempts: 1 },
      }),
    );
    expect(exhausted.action).toBe("complete");
    if (exhausted.action !== "complete") {
      return;
    }
    expect(exhausted.result.meta.error).toMatchObject({ kind: "incomplete_turn" });
  });

  it("continues once after a consumed exec refusal and a malformed different call", async () => {
    const turn = refusedExecThenRejectedCall();
    const retryState = createEmbeddedRunTerminalRetryState();
    const activateInternalPrompt = vi.fn();
    const input = makeTerminalInput({
      ...turn,
      retryState,
      sessionPromptState: { activateInternalPrompt },
    });

    await expect(resolveEmbeddedRunTerminal(input)).resolves.toEqual({ action: "retry" });
    expect(activateInternalPrompt).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Do not repeat completed tool calls"),
    );
    expect(turn.attempt.lastToolError).toEqual({
      toolName: "exec",
      executionStarted: false,
      mutatingAction: false,
    });
    expect((await resolveEmbeddedRunTerminal(input)).action).toBe("complete");
    expect(activateInternalPrompt).toHaveBeenCalledOnce();
  });

  it.each([
    "started",
    "unknown",
    "missing-result",
    "unconsumed",
    "prior-turn",
    "different-tool",
    "active",
    "async",
  ])("does not continue a %s tool failure", async (condition) => {
    const turn = refusedExecThenRejectedCall();
    const snapshot = turn.attempt.messagesSnapshot;
    switch (condition) {
      case "started":
        turn.attempt.lastToolError!.executionStarted = true;
        break;
      case "unknown":
        delete turn.attempt.lastToolError!.executionStarted;
        break;
      case "missing-result":
        snapshot.splice(2, 1);
        break;
      case "unconsumed":
        snapshot.push(snapshot.splice(2, 1)[0]);
        break;
      case "prior-turn":
        snapshot.splice(3, 0, { role: "user", content: "New task", timestamp: 1 });
        break;
      case "different-tool":
        turn.attempt.lastToolError!.toolName = "write";
        break;
      case "active":
        turn.attempt.itemLifecycle.activeCount = 1;
        break;
      case "async":
        turn.attempt.toolMetas[0].asyncStarted = true;
        break;
    }
    const activateInternalPrompt = vi.fn();
    const result = await resolveEmbeddedRunTerminal(
      makeTerminalInput({ ...turn, sessionPromptState: { activateInternalPrompt } }),
    );
    expect(result.action).toBe("complete");
    expect(activateInternalPrompt).not.toHaveBeenCalled();
  });

  it("also covers the malformed-arguments error code", async () => {
    const activateInternalPrompt = vi.fn();
    await expect(
      resolveEmbeddedRunTerminal(
        makeTerminalInput({
          ...rejectedCallAfterSettledTool(
            {},
            {
              errorMessage: "Provider completed tool call with malformed JSON arguments",
              errorCode: "malformed_tool_call_arguments",
            },
          ),
          sessionPromptState: { activateInternalPrompt },
        }),
      ),
    ).resolves.toEqual({ action: "retry" });
  });

  it("does not continue after an unrelated provider error", async () => {
    const overrides = {};
    const assistant = { errorMessage: "upstream connect error" };
    const activateInternalPrompt = vi.fn();
    const result = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        ...rejectedCallAfterSettledTool(overrides, assistant),
        sessionPromptState: { activateInternalPrompt },
      }),
    );

    expect(result.action).toBe("complete");
    expect(activateInternalPrompt).not.toHaveBeenCalled();
  });
});
