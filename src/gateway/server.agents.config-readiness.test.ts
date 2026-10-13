// Load the Gateway's deferred runtime during collection, outside the RPC deadline.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import fs from "node:fs/promises";
import path from "node:path";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { localStateOwnerFixtureEntrypoint } from "../cli/cli-entrypoint.test-support.js";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";
import {
  getRuntimeConfig,
  readConfigFileSnapshot,
  registerConfigWriteListener,
} from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { redactSensitiveText } from "../logging/redact.js";
import * as pluginLifecycleLease from "../plugins/plugin-lifecycle-lease.js";
import * as agentDatabaseResources from "../state/openclaw-agent-db-resources.js";
import { OpenClawStateLeaseAcquisitionError } from "../state/openclaw-state-lease-error.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import * as configReload from "./config-reload.js";
import * as agentDatabases from "./server-reload-agent-databases.js";
import { startGatewayServer } from "./server.js";
import * as sessionCreateDiagnostics from "./session-create-diagnostics.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

const cliEntrypoint = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(localStateOwnerFixtureEntrypoint),
);

it("publishes agent mutations before acknowledging immediate session and roster requests", async ({
  signal,
}) => {
  const resourceAdmission = agentDatabaseResources.assertAgentDatabaseResourceAdmission;
  const resourceAdmissionSpy = vi
    .spyOn(agentDatabaseResources, "assertAgentDatabaseResourceAdmission")
    .mockImplementation((...args) => {
      try {
        return resourceAdmission(...args);
      } catch (error) {
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
        process.stderr.write(
          `[config-readiness-database-admission] ${redactSensitiveText(detail)}\n`,
        );
        throw error;
      }
    });
  const agentId = "readiness-agent";
  let phase = "fixture setup";
  let teardownPhase: string | undefined;
  const overlappingPhases: Record<number, string> = {};
  const sessionCreatePhases: Record<number, string> = {};
  let nextSessionCreate = 0;
  const startSessionCreate = sessionCreateDiagnostics.startSessionCreateDiagnostics;
  const sessionCreateSpy = vi
    .spyOn(sessionCreateDiagnostics, "startSessionCreateDiagnostics")
    .mockImplementation(() => {
      const id = nextSessionCreate++;
      const diagnostics = startSessionCreate();
      sessionCreatePhases[id] = "preflight";
      return {
        mark(next: sessionCreateDiagnostics.SessionCreatePhase) {
          sessionCreatePhases[id] = next;
          diagnostics?.mark(next);
        },
        [Symbol.dispose]() {
          delete sessionCreatePhases[id];
          diagnostics?.[Symbol.dispose]();
        },
      };
    });
  const publicationEntered = createDeferred();
  const releasePublication = createDeferred();
  const creationBookkeepingCompleted = createDeferred();
  let publicationHeld = false;
  let reloadScheduler: GatewayScheduler | undefined;
  const startReloader = configReload.startGatewayConfigReloader;
  const reloaderSpy = vi
    .spyOn(configReload, "startGatewayConfigReloader")
    .mockImplementation((options) => {
      reloadScheduler = options.scheduler;
      return startReloader({
        ...options,
        log: {
          ...options.log,
          error: (message) => {
            process.stderr.write(`[config-readiness] ${message}\n`);
            options.log.error(message);
          },
        },
        onHotReload: async (...args) => {
          if (!publicationHeld && args[1].agents?.entries?.[agentId]) {
            publicationHeld = true;
            publicationEntered.resolve();
            await releasePublication.promise;
          }
          return options.onHotReload(...args);
        },
      });
    });
  const reviveDatabases = agentDatabases.reviveAgentDatabasesAfterConfigCommit;
  const revivalSpy = vi
    .spyOn(agentDatabases, "reviveAgentDatabasesAfterConfigCommit")
    .mockImplementation(async (...args) => {
      await reviveDatabases(...args);
      if (args[0].length === 1 && args[0][0] === agentId) {
        creationBookkeepingCompleted.resolve();
      }
    });
  onTestFinished(() => {
    process.stderr.write(
      `[config-readiness] ${JSON.stringify({ phase, overlappingPhases, sessionCreatePhases, teardownPhase })}\n`,
    );
    releasePublication.resolve();
    resourceAdmissionSpy.mockRestore();
    sessionCreateSpy.mockRestore();
    reloaderSpy.mockRestore();
    revivalSpy.mockRestore();
  });
  await withOpenClawTestState(
    {
      label: "agent-config-readiness",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    },
    async (state) => {
      const token = "agent-config-readiness-token";
      const recoveryRestart = vi.fn(() => {
        throw new Error("Agent mutations must hot-apply without a recovery restart");
      });
      await state.writeConfig({
        gateway: { mode: "local", auth: { mode: "token", token } },
        agents: {
          ownership: "explicit",
          defaults: { skipBootstrap: true, model: "openai/gpt-4.1", heartbeat: { every: "0m" } },
          entries: { main: { workspace: state.workspaceDir } },
        },
        plugins: { slots: { memory: "none" } },
      });
      phase = "acquiring port";
      const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      phase = "acquiring Gateway lock";
      const owner = await acquireGatewayLock({
        env: state.env,
        port: claim.port,
        allowInTests: true,
      });
      assert.isNotNull(owner);
      phase = "starting Gateway";
      const server = await startGatewayServer(claim.port, {
        gatewayStateOwner: owner,
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
        hotReloadRecovery: recoveryRestart,
      });
      try {
        phase = "settling Gateway startup";
        await server.startupSettled;
        phase = "connecting client";
        const client = await connectGatewayClient({
          url: `ws://127.0.0.1:${claim.port}`,
          token,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        try {
          const key = `agent:${agentId}:first-session`;
          let creationAcknowledged = false;
          await expect(
            client.request("agents.create", {
              name: "Retired Owner",
              workspace: path.join(state.home, "workspace-retired"),
              expectedOwnerId: "retired-owner",
            }),
          ).rejects.toMatchObject({
            code: "UNAVAILABLE",
            details: { reason: "STATE_OWNER_CHANGED", mutationAccepted: false },
          });
          await expect(fs.stat(path.join(state.home, "workspace-retired"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          phase = "launching CLI creation";
          const creation = runCliProcessChild({
            nodeArgs: [
              ...cliEntrypoint,
              "agents",
              "add",
              "Readiness Agent",
              "--non-interactive",
              "--json",
              "--workspace",
              path.join(state.home, "workspace-readiness"),
              "--model",
              "openai/gpt-5.6-sol",
            ],
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              ...state.envVars,
              OPENCLAW_GATEWAY_TOKEN: token,
              OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:1",
              OPENCLAW_NO_RESPAWN: "1",
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            },
          }).then((result) => {
            expect(result.code, result.stderr).toBe(0);
            return JSON.parse(result.stdout);
          });
          const firstSession = creation
            .then(() => {
              creationAcknowledged = true;
              return client.request("sessions.create", { agentId, key });
            })
            .then(
              (value) => ({ ok: true as const, value }),
              (error: unknown) => ({ ok: false as const, error }),
            );
          try {
            phase = "awaiting held publication and creation bookkeeping";
            await withinTest(
              Promise.race([
                Promise.all([publicationEntered.promise, creationBookkeepingCompleted.promise]),
                firstSession.then((result) => {
                  if (!result.ok) {
                    throw result.error;
                  }
                  throw new Error("Creation finished before reaching the held config publication");
                }),
              ]),
              signal,
            );
            // Finish a wire read after creation bookkeeping, while publication remains held.
            await expect(client.request("agents.list", {})).resolves.toMatchObject({
              agents: expect.not.arrayContaining([expect.objectContaining({ id: agentId })]),
            });
            if (creationAcknowledged) {
              const result = await withinTest(firstSession, signal);
              if (!result.ok) {
                throw result.error;
              }
            }
            expect(
              creationAcknowledged,
              "agents.create acknowledged before runtime publication",
            ).toBe(false);
          } finally {
            releasePublication.resolve();
          }
          phase = "awaiting CLI creation completion";
          await expect(creation).resolves.toMatchObject({ agentId });
          phase = "agent CRUD: agents.list after creation";
          await expect(client.request("agents.list", {})).resolves.toMatchObject({
            agents: expect.arrayContaining([expect.objectContaining({ id: agentId })]),
          });
          phase = "agent CRUD: first sessions.create";
          const createdSession = await withinTest(firstSession, signal);
          if (!createdSession.ok) {
            throw createdSession.error;
          }
          expect(createdSession.value).toMatchObject({ key });
          phase = "agent CRUD: sessions.list after creation";
          await expect(client.request("sessions.list", { agentId })).resolves.toMatchObject({
            sessions: expect.arrayContaining([expect.objectContaining({ key })]),
          });

          phase = "agent CRUD: agents.update";
          await expect(
            client.request("agents.update", {
              agentId,
              name: "Ready Immediately",
              model: "openai/gpt-4.1",
            }),
          ).resolves.toMatchObject({ ok: true, agentId });
          phase = "agent CRUD: agents.list after update";
          await expect(client.request("agents.list", {})).resolves.toMatchObject({
            agents: expect.arrayContaining([
              expect.objectContaining({ id: agentId, name: "Ready Immediately" }),
            ]),
          });
          expect(
            resolveAgentModelPrimaryValue(getRuntimeConfig().agents?.entries?.[agentId]?.model),
          ).toBe("openai/gpt-4.1");
          phase = "agent CRUD: sessions.create after update";
          await expect(
            client.request("sessions.create", { agentId, key: `agent:${agentId}:after-update` }),
          ).resolves.toMatchObject({ key: `agent:${agentId}:after-update` });

          phase = "agent CRUD: agents.delete";
          await expect(
            client.request("agents.delete", { agentId, deleteFiles: false }),
          ).resolves.toMatchObject({ ok: true, agentId });
          for (const incognito of [false, true]) {
            phase = `agent CRUD: sessions.create after delete (incognito=${incognito})`;
            await expect(
              client.request("sessions.create", {
                agentId,
                key: `agent:${agentId}:after-delete`,
                incognito,
              }),
            ).rejects.toThrow(`Unknown agent id "${agentId}"`);
          }
          expect(getRuntimeConfig().agents?.entries?.[agentId]).toBeUndefined();

          phase = "connecting concurrent operator";
          const peer = await connectGatewayClient({
            url: `ws://127.0.0.1:${claim.port}`,
            token,
            scopes: ["operator.admin", "operator.read", "operator.write"],
          });
          try {
            phase = "concurrent mutations";
            await withinTest(
              Promise.all(
                [client, peer].map(async (operator, index) => {
                  const otherOperator = index === 0 ? peer : client;
                  for (let round = 0; round < 4; round += 1) {
                    const overlapAgentId = `overlap-${index}-${round}`;
                    overlappingPhases[index] = `${overlapAgentId}: create`;
                    await expect(
                      operator.request("agents.create", {
                        name: overlapAgentId,
                        workspace: path.join(state.home, overlapAgentId),
                      }),
                    ).resolves.toMatchObject({ agentId: overlapAgentId });
                    overlappingPhases[index] = `${overlapAgentId}: session`;
                    await expect(
                      operator.request("sessions.create", {
                        agentId: "main",
                        key: `agent:main:${overlapAgentId}`,
                      }),
                    ).resolves.toMatchObject({ key: `agent:main:${overlapAgentId}` });
                    overlappingPhases[index] = `${overlapAgentId}: delete`;
                    const deletion = { agentId: overlapAgentId, deleteFiles: false };
                    if (round === 0) {
                      const results = await Promise.allSettled([
                        operator.request("agents.delete", deletion),
                        otherOperator.request("agents.delete", deletion),
                      ]);
                      expect(results.filter((result) => result.status === "fulfilled")).toEqual([
                        {
                          status: "fulfilled",
                          value: expect.objectContaining({ ok: true, agentId: overlapAgentId }),
                        },
                      ]);
                      const failure: unknown = results.find(
                        (result) => result.status === "rejected",
                      )?.reason;
                      if (
                        failure instanceof GatewayClientRequestError &&
                        failure.code === "UNAVAILABLE"
                      ) {
                        // Cleanup can outlast the concurrent loser's five-second lease wait.
                        expect(failure.message).toContain(
                          `agent deletion core:agent-deletion/${overlapAgentId} is held by `,
                        );
                        expect(failure.message).toContain("code=OPENCLAW_STATE_LEASE_HELD");
                      } else {
                        expect(failure).toMatchObject({
                          code: "INVALID_REQUEST",
                          message: `agent "${overlapAgentId}" not found`,
                        });
                      }
                    } else {
                      await expect(
                        operator.request("agents.delete", deletion),
                      ).resolves.toMatchObject({
                        ok: true,
                        agentId: overlapAgentId,
                      });
                    }
                    expect(getRuntimeConfig().agents?.entries?.[overlapAgentId]).toBeUndefined();
                  }
                }),
              ),
              signal,
            );
          } finally {
            teardownPhase = "disconnect peer";
            await disconnectGatewayClient(peer);
            teardownPhase = undefined;
          }

          phase = "injected reload failures";
          assert.isDefined(reloadScheduler);
          const clock = createGatewaySchedulerClock();
          const scheduler = createTestGatewayScheduler(clock.clock);
          const schedule = reloadScheduler.schedule.bind(reloadScheduler);
          let written = createDeferred();
          let awaitingAgent = "";
          const unsubscribe = registerConfigWriteListener((event) => {
            if (event.sourceConfig.agents?.entries?.[awaitingAgent]) {
              written.resolve();
            }
          });
          const scheduleSpy = vi.spyOn(reloadScheduler, "schedule").mockImplementation((job) => {
            if (job.id !== "config:reload") {
              return schedule(job);
            }
            return scheduler.schedule(job);
          });
          try {
            for (const reason of ["storage-error", "lifecycle-busy"] as const) {
              written = createDeferred();
              const unavailableAgent = `unavailable-${reason}`;
              awaitingAgent = unavailableAgent;
              const failedCreation = client
                .request("agents.create", {
                  name: unavailableAgent,
                  workspace: path.join(state.home, unavailableAgent),
                })
                .then(
                  (value) => ({ value }),
                  (error: unknown) => ({ error }),
                );
              await withinTest(written.promise, signal);
              const acquire = vi
                .spyOn(pluginLifecycleLease, "withPluginLifecycleLease")
                .mockRejectedValue(
                  new OpenClawStateLeaseAcquisitionError("plugin lifecycle lease", {
                    kind: "store-unavailable",
                    reason,
                  }),
                );
              try {
                for (const delay of reason === "storage-error"
                  ? [0]
                  : [0, 250, 500, 1000, 2000, 4000, 5000]) {
                  await clock.advanceBy(delay);
                }
                expect(acquire).toHaveBeenCalledTimes(reason === "storage-error" ? 1 : 7);
                expect(await withinTest(failedCreation, signal)).toMatchObject({
                  error: { code: "UNAVAILABLE", message: expect.stringContaining("(failed)") },
                });
                expect(
                  (await readConfigFileSnapshot()).sourceConfig.agents?.entries?.[unavailableAgent],
                ).toBeDefined();
                expect(getRuntimeConfig().agents?.entries?.[unavailableAgent]).toBeUndefined();
              } finally {
                acquire.mockRestore();
              }
            }
          } finally {
            unsubscribe();
            scheduleSpy.mockRestore();
            teardownPhase = "stop injected scheduler";
            await scheduler.stop();
            teardownPhase = undefined;
          }

          phase = "disabled reload";
          const saved = (await readConfigFileSnapshot()).sourceConfig;
          await state.writeConfig({
            ...saved,
            gateway: { ...saved.gateway, reload: { mode: "off" } },
          });
          await expect(
            client.request("agents.create", {
              name: "Saved Only",
              workspace: path.join(state.home, "workspace-saved-only"),
            }),
          ).rejects.toMatchObject({
            code: "UNAVAILABLE",
            message: expect.stringContaining("saved"),
          });
          expect(
            (await readConfigFileSnapshot()).sourceConfig.agents?.entries?.["saved-only"],
          ).toBeDefined();
          expect(getRuntimeConfig().agents?.entries?.["saved-only"]).toBeUndefined();
          expect(recoveryRestart).not.toHaveBeenCalled();
          phase = "completed";
        } catch (error) {
          process.stderr.write(
            `[config-readiness-failure] ${JSON.stringify({
              phase,
              name: error instanceof Error ? error.name : typeof error,
              message:
                error instanceof Error
                  ? redactSensitiveText(error.message, { mode: "tools" })
                  : undefined,
              frames:
                error instanceof Error
                  ? (error.stack ?? "")
                      .split("\n")
                      .slice(1, 6)
                      .map((frame) => frame.split(/[\\/]/).at(-1) ?? "")
                  : [],
            })}\n`,
          );
          throw error;
        } finally {
          teardownPhase = "disconnect client";
          await disconnectGatewayClient(client);
          teardownPhase = undefined;
        }
      } finally {
        teardownPhase = "close Gateway";
        await server.close();
        teardownPhase = "release Gateway lock";
        await owner.release();
        teardownPhase = "release port claim";
        await claim.release();
        teardownPhase = "state fixture cleanup";
      }
    },
  );
  teardownPhase = "completed";
});
