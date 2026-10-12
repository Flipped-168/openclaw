import { randomUUID } from "node:crypto";
import { defineCodexBuildState } from "../build-state.js";
import { readCodexInferenceMetadata, type CodexInferenceMetadata } from "./inference-metadata.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

export { CODEX_INFERENCE_GENERATION_KEY } from "./inference-metadata.js";

const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_ACTIVE_ROOTS = 64;
const MAX_PREPARED_PREFIXES = 256;
const MAX_RETAINED_REQUEST_BYTES = 32 * 1024 * 1024;
type PreparedPrefix = { text: string };
const retained = defineCodexBuildState("openclaw.codexPreparedRequests", () => ({
  requests: new Map<PreparedPrefix, { body: JsonObject; bytes: number }>(),
  bytes: 0,
}))();

function forgetRequest(prefix: PreparedPrefix | undefined) {
  if (!prefix) {
    return;
  }
  const request = retained.requests.get(prefix);
  if (request) {
    retained.bytes -= request.bytes;
    retained.requests.delete(prefix);
  }
}

function retainRequest(prefix: PreparedPrefix, body: JsonObject) {
  forgetRequest(prefix);
  // A continuation contains only a delta; its server-side prefix is not in this snapshot.
  if (body.previous_response_id != null) {
    return;
  }
  const snapshot: JsonObject = {};
  for (const key of ["instructions", "tools", "input"]) {
    if (key in body) {
      snapshot[key] = body[key];
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (bytes > MAX_RETAINED_REQUEST_BYTES) {
    return;
  }
  while (retained.bytes + bytes > MAX_RETAINED_REQUEST_BYTES) {
    forgetRequest(retained.requests.keys().next().value);
  }
  retained.requests.set(prefix, { body: snapshot, bytes });
  retained.bytes += bytes;
}

type Registration = {
  generation: string;
  text: string;
  forkPrefix?: JsonObject;
  controller: AbortController;
  assertCurrent: () => void;
  release: () => void;
};

/** One physical inference transport owns these confidential, nonpersistent snapshots. */
export function createCodexInferenceContext(assertClientCurrent: () => void) {
  const roots = new Map<string, Registration>();
  // Prepared bytes survive turn settlement, but confer no execution authority.
  const prefixes = new Map<string, PreparedPrefix>();
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("Codex parent-local inference transport is closed");
    }
    assertClientCurrent();
  };
  return {
    register(params: {
      threadId: string;
      text: string;
      signal: AbortSignal;
      assertCurrent: () => void;
      retainPrefix?: boolean;
      forkPrefix?: JsonObject;
    }) {
      assertOpen();
      params.signal.throwIfAborted();
      params.assertCurrent();
      if (Buffer.byteLength(params.text) > MAX_CONTEXT_BYTES) {
        throw new Error("Codex parent-local context exceeds the 256 KiB inference limit");
      }
      if (!roots.has(params.threadId) && roots.size >= MAX_ACTIVE_ROOTS) {
        throw new Error("Codex parent-local inference root limit reached");
      }
      if (
        params.retainPrefix !== false &&
        !prefixes.has(params.threadId) &&
        prefixes.size >= MAX_PREPARED_PREFIXES
      ) {
        throw new Error("Codex prepared inference prefix limit reached; reconnect before retrying");
      }
      roots.get(params.threadId)?.release();
      const controller = new AbortController();
      const registration: Registration = {
        generation: randomUUID(),
        text: params.text,
        forkPrefix: params.forkPrefix,
        controller,
        assertCurrent: () => {
          assertOpen();
          controller.signal.throwIfAborted();
          params.signal.throwIfAborted();
          params.assertCurrent();
          if (roots.get(params.threadId) !== registration) {
            throw new Error("Codex parent-local inference generation was replaced");
          }
        },
        release: () => {
          if (roots.get(params.threadId) === registration) {
            roots.delete(params.threadId);
          }
          registration.text = "";
          controller.abort();
          params.signal.removeEventListener("abort", registration.release);
        },
      };
      roots.set(params.threadId, registration);
      if (params.retainPrefix !== false) {
        const prefix = prefixes.get(params.threadId);
        if (prefix) {
          prefix.text = params.text;
        } else {
          prefixes.set(params.threadId, { text: params.text });
        }
      }
      params.signal.addEventListener("abort", registration.release, { once: true });
      return { generation: registration.generation, release: registration.release };
    },
    /** A retained prefix is data; only the new root's caller grants model authority. */
    fork(params: {
      sourceThreadId: string;
      threadId: string;
      signal: AbortSignal;
      assertCurrent: () => void;
    }) {
      assertOpen();
      const prefix = prefixes.get(params.sourceThreadId);
      if (!prefix) {
        throw new Error("Cache-parity fork has no prepared parent inference context.");
      }
      const request = retained.requests.get(prefix);
      if (request) {
        // LRU is global across private routes; active forks keep their admitted snapshot.
        retained.requests.delete(prefix);
        retained.requests.set(prefix, request);
      }
      return this.register({
        threadId: params.threadId,
        text: prefix.text,
        forkPrefix: request?.body,
        retainPrefix: false,
        signal: params.signal,
        assertCurrent: params.assertCurrent,
      });
    },
    forget(threadId: string) {
      forgetRequest(prefixes.get(threadId));
      prefixes.delete(threadId);
      roots.get(threadId)?.release();
    },
    /** Caller must authenticate its private transport before parsing any model request. */
    // Host-held OAuth may fund only admitted generations; native background work has no such grant.
    prepare(body: JsonObject, preparedMetadata?: CodexInferenceMetadata, requireAdmission = false) {
      assertOpen();
      const metadata = preparedMetadata ?? readCodexInferenceMetadata(body);
      const child = Boolean(metadata.parentThreadId || metadata.subagentKind || metadata.subagent);
      const kind = metadata.requestKind;
      // Native children/reviewers and compaction/memory keep their original instructions.
      if (!requireAdmission && (child || kind === "compaction" || kind === "memory")) {
        return { body, assertCurrent: assertOpen, signal: undefined };
      }
      if (
        child ||
        (kind !== "turn" && kind !== "prewarm" && !(requireAdmission && kind === "compaction"))
      ) {
        throw new Error("Codex inference request has an unsupported native purpose");
      }
      const registration = metadata.threadId ? roots.get(metadata.threadId) : undefined;
      const generation = metadata.generation;
      // Startup prewarm precedes host admission; it must never borrow a later turn's persona.
      if (
        !requireAdmission &&
        kind === "prewarm" &&
        body.generate === false &&
        generation == null
      ) {
        return { body, assertCurrent: assertOpen, signal: undefined };
      }
      if (!registration || generation !== registration.generation) {
        throw new Error("Codex inference has no current admitted parent generation");
      }
      registration.assertCurrent();
      let preparedBody = body;
      if (kind !== "compaction") {
        // Responses Lite carries native base instructions in input and omits this optional field.
        const instructions = body.instructions;
        if (instructions !== undefined && typeof instructions !== "string") {
          throw new Error("Codex inference request has invalid top-level instructions");
        }
        if (registration.text) {
          preparedBody = {
            ...body,
            instructions:
              instructions === undefined
                ? registration.text
                : instructions + "\n\n" + registration.text,
          };
        }
      }
      if (kind === "turn") {
        const prefix = registration.forkPrefix;
        const question = Array.isArray(body.input)
          ? body.input.findLast((item) => isJsonObject(item) && item.role === "user")
          : undefined;
        if (prefix && Array.isArray(prefix.input) && question) {
          // Native thread/fork reconstructs persisted history and settings. Replay the
          // last actual wire prefix instead, without normalizing any prompt or schema.
          preparedBody = { ...body };
          delete preparedBody.previous_response_id;
          for (const key of ["instructions", "tools", "input"]) {
            delete preparedBody[key];
          }
          Object.assign(preparedBody, prefix);
          preparedBody.input = [...prefix.input, question];
          // Keep hosted tool declarations cache-identical, but never execute them.
          preparedBody.tool_choice = "none";
        }
        const retainedPrefix = metadata.threadId ? prefixes.get(metadata.threadId) : undefined;
        if (retainedPrefix) {
          retainRequest(retainedPrefix, preparedBody);
        }
      }
      return {
        body: preparedBody,
        assertCurrent: registration.assertCurrent,
        signal: registration.controller.signal,
      };
    },
    close() {
      closed = true;
      for (const prefix of prefixes.values()) {
        forgetRequest(prefix);
      }
      prefixes.clear();
      for (const registration of roots.values()) {
        registration.release();
      }
    },
  };
}
