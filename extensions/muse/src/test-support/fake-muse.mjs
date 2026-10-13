#!/usr/bin/env node
import { createInterface } from "node:readline";
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";

let cursor = 0;
let sessionCount = 0;
let active;
const sessions = new Map();
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
const reply = (id, result) => send({ id, result });
const event = (method, params) =>
  send({ method, params: { ...params, viewCursor: String(++cursor) } });
const sourceRange = { start: 0, end: 1 };
function item(kind, text, status = "completed", extra = {}) {
  return {
    itemId: `${active.turnId}-${kind}`,
    turnId: active.turnId,
    kind,
    text,
    revision: status === "inProgress" ? 1 : 2,
    status,
    ...extra,
  };
}
function complete(terminal, error) {
  event("turn/completed", { ...active, terminal, sourceRange, ...(error ? { error } : {}) });
}
function answer() {
  const reasoning = item("reasoning", "", "inProgress");
  event("item/started", { ...active, item: reasoning });
  event("item/delta", {
    ...active,
    itemId: reasoning.itemId,
    field: "summary.0",
    delta: "Considering",
  });
  event("item/completed", {
    ...active,
    item: { ...reasoning, status: "completed", revision: 2, summary: ["Considering"] },
    sourceRange,
  });
  if (active.prompt === "tool") {
    event("item/completed", {
      ...active,
      item: item("toolCall", undefined, "completed", {
        tool: "read_file",
        callId: "call-1",
        args: '{"path":"a.txt"}',
        visibleOutput: "file content",
      }),
      sourceRange,
    });
  }
  const text =
    active.prompt === "credential"
      ? `credential:${process.env.META_API_KEY ?? "cli-login"}`
      : active.prompt === "effort"
        ? `effort:${active.reasoningEffort}`
        : `${active.resumed ? "resumed" : "started"}: hello`;
  const message = item("agentMessage", "", "inProgress");
  event("item/started", { ...active, item: message });
  event("item/delta", { ...active, itemId: message.itemId, delta: text.slice(0, 8) });
  event("item/delta", { ...active, itemId: message.itemId, delta: text.slice(8) });
  event("item/completed", {
    ...active,
    item: { ...message, text, status: "completed", revision: 2 },
    sourceRange,
  });
  complete("completed");
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === "initialized") {
    return;
  }
  if (method === "initialize") {
    reply(id, {
      serverInfo: { name: "fake_muse", version: "1" },
      schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT, version: 1 },
      grantedCapabilities: ["sessionMcp"],
      experimentalApi: false,
      platformOs: "linux",
    });
  } else if (method === "session/start") {
    const sessionId = `session-${++sessionCount}`;
    sessions.set(sessionId, false);
    reply(id, { session: { sessionId }, viewCursor: String(cursor) });
  } else if (method === "session/resume") {
    if (params.sessionId === "missing-session") {
      send({
        id,
        error: { code: -32020, message: "session not found", data: { kind: "sessionNotFound" } },
      });
      return;
    }
    sessions.set(params.sessionId, true);
    reply(id, {
      session: { sessionId: params.sessionId },
      history: { mode: "none" },
      viewCursor: String(cursor),
    });
  } else if (method === "turn/start") {
    active = {
      sessionId: params.sessionId,
      turnId: params.commandId,
      prompt: params.input[0].text,
      resumed: sessions.get(params.sessionId),
      reasoningEffort: params.reasoningEffort,
    };
    reply(id, {
      commandId: params.commandId,
      status: "accepted",
      disposition: "started",
      startedNewTurn: true,
      turnId: active.turnId,
    });
    setImmediate(() => {
      event("turn/started", { ...active, commandId: params.commandId, sourceRange });
      if (active.prompt === "crash") {
        process.stderr.write("fixture: provider process crashed\n");
        process.exit(7);
      } else if (active.prompt === "fail") {
        complete("failed", {
          kind: "providerError",
          message: "fixture provider rejected authentication",
          retryable: false,
        });
      } else if (active.prompt === "approval") {
        event("approval/requested", {
          ...active,
          approvalId: "approval-1",
          currentRequirementId: { approvalId: "approval-1", sourceIndex: 0 },
          availableChoices: [
            { choiceId: "server-allow-id", decision: "approved", scope: "once", label: "Allow" },
            { choiceId: "server-deny-id", decision: "denied", scope: "once", label: "Deny" },
          ],
          itemId: "tool-1",
          toolCallId: "call-1",
          toolName: "shell",
          rawArgs: '{"command":"pwd"}',
          subject: { kind: "command", command: "pwd" },
          judgeEscalated: false,
          protectedWrite: false,
          taskId: "task-1",
          sourceRange,
        });
      } else if (active.prompt !== "wait") {
        answer();
      }
    });
  } else if (method === "approval/decide") {
    reply(id, { commandId: params.commandId, status: "accepted", approvalId: params.approvalId });
    if (params.choiceId !== "server-allow-id") {
      complete("failed", { kind: "approvalDenied", message: "denied", retryable: false });
    } else {
      setImmediate(answer);
    }
  } else if (method === "turn/interrupt") {
    reply(id, { commandId: params.commandId, status: "accepted" });
    complete("cancelled");
  } else {
    send({ id, error: { code: -32601, message: `Unsupported fixture method ${method}` } });
  }
});
