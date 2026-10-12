import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateChatInjectParams,
  validateChatToolTitlesParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import { readRetainedSessionEntryFacts } from "../../config/sessions/session-entry-read-facts.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  projectChatDisplayMessage,
  resolveEffectiveChatHistoryMaxChars,
} from "../chat-display-projection.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { loadSessionEntryAsync } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  resolveGlobalAwareNodeChatDeliveryKeys,
  sendGlobalAwareNodeChatPayload,
} from "./chat-broadcast.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const chatHandlers: GatewayRequestHandlers = {
  ...chatHistoryHandlers,
  ...chatMessageGetHandlers,
  "chat.toolTitles": async ({ params, respond }) => {
    if (!assertValidParams(params, validateChatToolTitlesParams, "chat.toolTitles", respond)) {
      return;
    }
    // Keep the shipped disabled response until a versioned protocol removal;
    // older clients stop asking, while current clients read the tool call title.
    respond(true, { titles: {}, disabled: true });
  },
  "chat.inject": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateChatInjectParams, "chat.inject", respond)) {
      return;
    }
    const rawSessionKey = params.sessionKey;
    const agentIdOverride = normalizeOptionalString(params.agentId);
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedSessionAgentId(cfg, rawSessionKey, agentIdOverride);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const sessionLoadOptions = { agentId: requestedAgent.agentId };
    const {
      agentId,
      storePath,
      readSource,
      entry,
      legacyKey,
      canonicalKey: sessionKey,
    } = await loadSessionEntryAsync(rawSessionKey, sessionLoadOptions, cfg);
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }
    const storageKey = legacyKey ?? sessionKey;
    const metadata = captureSessionEntryMetadataRead({
      agentId,
      sessionKey: storageKey,
      storePath,
    });

    let appended: Awaited<ReturnType<typeof appendInjectedAssistantMessageToTranscript>>;
    try {
      const admission = await beginSessionWorkAdmission({
        agentId,
        scope: storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {
          // Admission can wait behind archive/reset; use the owner's committed facts at entry.
          const latestEntry = metadata
            ? metadata.readCurrent()
            : readRetainedSessionEntryFacts(
                {
                  agentId: readSource?.agentId ?? agentId,
                  path: readSource?.path ?? storePath,
                },
                { sessionKeys: [storageKey], projection: "exact", snapshotFields: [] },
              )?.entries.find((row) => row.sessionKey === storageKey)?.entry;
          const archivedError = resolveSessionWorkStartError(sessionKey, latestEntry, {
            expectedSessionId: sessionId,
          });
          if (archivedError) {
            throw new Error(archivedError);
          }
        },
      });
      try {
        appended = await admission.run(
          async () =>
            await appendInjectedAssistantMessageToTranscript({
              sessionKey,
              message: params.message,
              label: params.label,
              sessionId,
              storePath,
              agentId,
              config: cfg,
            }),
        );
      } finally {
        admission.release();
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
      return;
    }
    if (!appended.ok || !appended.messageId || !appended.message) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to write transcript: ${appended.error ?? "unknown error"}`,
        ),
      );
      return;
    }

    const message = projectChatDisplayMessage(appended.message, {
      maxChars: resolveEffectiveChatHistoryMaxChars(),
    });
    const chatPayload = {
      runId: `inject-${appended.messageId}`,
      sessionKey,
      ...(agentId ? { agentId } : {}),
      seq: 0,
      state: "final" as const,
      message,
    };
    context.broadcast("chat", chatPayload, {
      sessionKeys: resolveGlobalAwareNodeChatDeliveryKeys({ cfg, sessionKey, agentId }),
    });
    sendGlobalAwareNodeChatPayload({
      context,
      sessionKey,
      agentId,
      event: "chat",
      payload: chatPayload,
    });

    respond(true, { ok: true, messageId: appended.messageId });
  },
};
