import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { runBtwSideQuestion } from "../agents/btw.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
} from "../plugins/runtime/gateway-request-scope.js";
import * as commandQueue from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { CommandLane } from "../process/lanes.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  disposeSessionReadContexts,
  identifiedClient,
  initializeSessionReadContext,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestOptions,
} from "./server-methods/types.js";
import { createGatewaySubagentRuntime } from "./server-plugin-subagent-runtime.js";
import { requireSessionRowProjection } from "./session-row-projection-access.js";

const sideQuestion = vi.hoisted(() => vi.fn<typeof runBtwSideQuestion>());
// mock-isolation: the Gateway admission is real; the provider runtime is replaced at its boundary.
vi.mock("../agents/btw.js", () => ({ runBtwSideQuestion: sideQuestion }));

const PLUGIN_ID = "test-session-fork";
const sessionKey = "agent:research:fork-parent";
let config: OpenClawConfig;
let context: GatewayRequestContext;
let lifetime: AbortController;

function fork(client?: GatewayRequestOptions["client"]) {
  const run = () =>
    createGatewaySubagentRuntime(() => context, {}, lifetime.signal).forkSession({
      sessionKey,
      message: "Review the current work",
    });
  return client
    ? withPluginRuntimeGatewayRequestScope(
        { pluginId: PLUGIN_ID, client, isWebchatConnect: () => false },
        run,
      )
    : withPluginRuntimePluginScope({ pluginId: PLUGIN_ID }, run);
}

async function withSession(run: (client: GatewayClient) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const owner = ensureProfileForEmail("fork-owner@example.test");
    config.gateway = {
      roles: {
        default: "limited",
        definitions: {
          limited: {
            agents: ["research"],
            scopes: ["operator.read", "operator.write"],
            sessions: { others: "none" },
          },
        },
      },
    };
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    await upsertSessionEntryCore(
      { agentId: "research", sessionKey },
      {
        sessionId: "parent-session",
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: owner.id },
      },
    );
    context = requestContext(config);
    await initializeSessionReadContext(context);
    try {
      await run(identifiedClient(owner.id));
    } finally {
      await disposeSessionReadContexts();
    }
  });
}

beforeEach(() => {
  resetCommandQueueStateForTest();
  commandQueue.setCommandLaneConcurrency(CommandLane.Subagent, 3);
  sideQuestion.mockReset().mockResolvedValue({ text: "Looks correct." });
  config = {
    agents: { entries: { research: { model: "test-provider/research-model" } } },
    plugins: { entries: { [PLUGIN_ID]: { hooks: { allowConversationAccess: true } } } },
  };
  setRuntimeConfigSnapshot(config);
  context = requestContext(config);
  lifetime = new AbortController();
});

afterEach(() => {
  lifetime.abort();
  resetCommandQueueStateForTest();
  resetConfigRuntimeState();
  vi.restoreAllMocks();
});

describe("plugin session forks", () => {
  it("requires explicit conversation access for an external plugin", async () => {
    config.plugins = {};
    await expect(fork()).rejects.toThrow(
      `plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess`,
    );
    expect(sideQuestion).not.toHaveBeenCalled();
  });

  it("uses the session side-question owner and returns billed cache usage", async () => {
    await withSession(async (client) => {
      sideQuestion.mockImplementation(async (params) => {
        expect(params).toMatchObject({
          agentId: "research",
          provider: "test-provider",
          model: "research-model",
          sessionKey,
          sessionEntry: { sessionId: "parent-session" },
          toolCalls: "deny",
          isNewSession: false,
        });
        expect(params.opts).not.toHaveProperty("onBlockReply");
        expect(params.operatorAuthority).toBeDefined();
        params.assertCurrent?.();
        params.onUsage?.({ input: 6, output: 4, cacheRead: 20, total: 30 });
        return { text: "Looks correct." };
      });
      await expect(fork(client)).resolves.toEqual({
        text: "Looks correct.",
        usage: { inputTokens: 6, outputTokens: 4, cacheReadTokens: 20, totalTokens: 30 },
      });
    });
  });

  it("keeps fork admission current while parent projection facts are rematerializing", async () => {
    await withSession(async (client) => {
      const projection = requireSessionRowProjection(context);
      sideQuestion.mockImplementationOnce(async (params) => {
        params.assertCurrent?.();
        sessionChanges.emit({
          agentId: "research",
          sessionKey,
          scope: "session-entry",
          factsInvalidated: "category",
        });
        expect(projection.needsMaterialization).toBe(true);
        expect(projection.describe({ agentId: "research", key: sessionKey })).toBeUndefined();
        params.assertCurrent?.();
        return { text: "Reviewed the settled parent." };
      });
      try {
        await expect(fork(client)).resolves.toEqual({ text: "Reviewed the settled parent." });
      } finally {
        await projection.ensureMaterialized();
      }
    });
  });

  it("rejects another operator's session even when the agent is allowed", async () => {
    await withSession(async () => {
      const stranger = ensureProfileForEmail("fork-stranger@example.test");
      await expect(fork(identifiedClient(stranger.id))).rejects.toThrow(
        `Session "${sessionKey}" was not found`,
      );
      expect(sideQuestion).not.toHaveBeenCalled();
    });
  });

  it.each([
    "Gateway binding",
    "conversation access",
    "session identity",
    "session lifecycle",
    "session visibility",
  ])("revalidates %s after side-question preparation before inference", async (authority) => {
    await withSession(async (client) => {
      let caller = client;
      if (authority === "session visibility") {
        const role = config.gateway?.roles?.definitions?.limited;
        if (!role) {
          throw new Error("Missing fixture role");
        }
        role.sessions = { others: "view" };
        caller = identifiedClient(ensureProfileForEmail("fork-viewer@example.test").id);
      }
      const preparing = createDeferred();
      const finishPreparation = createDeferred();
      const inference = vi.fn();
      sideQuestion.mockImplementationOnce(async (params) => {
        preparing.resolve();
        await finishPreparation.promise;
        params.assertCurrent?.();
        inference();
        return { text: "must not be generated" };
      });
      const result = fork(caller);
      const rejected = expect(result).rejects.toThrow(
        /current gateway instance binding|allowConversationAccess|changed|not found/u,
      );
      try {
        await awaitGateBeforeSettlement(
          preparing.promise,
          result,
          "Session fork settled before side-question preparation",
        );
        if (authority === "Gateway binding") {
          context = requestContext(config);
        } else if (authority === "conversation access") {
          config.plugins = {};
        } else if (authority === "session visibility") {
          await upsertSessionEntryCore(
            { agentId: "research", sessionKey },
            { visibility: "draft" },
          );
        } else if (authority === "session lifecycle") {
          await upsertSessionEntryCore(
            { agentId: "research", sessionKey },
            { lifecycleRevision: "replacement-lifecycle" },
          );
        } else {
          await upsertSessionEntryCore(
            { agentId: "research", sessionKey },
            { sessionId: "replacement-session", updatedAt: 2 },
          );
        }
      } finally {
        finishPreparation.resolve();
      }
      await rejected;
      expect(inference).not.toHaveBeenCalled();
    });
  });
});
