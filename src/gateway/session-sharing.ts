import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import {
  getSessionActorStorageBinding,
  runWithSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
import type { SessionPendingInputAuthorityFacts } from "../config/sessions/session-pending-input-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import {
  authorizeGatewaySessionCreation,
  operatorSessionCap,
  resolveGatewayOperatorRoleActor,
} from "./operator-role-policy.js";
import type { SessionMutationAuthorization } from "./server-methods/types.js";
import { isSessionCreatorProfile } from "./session-creator.js";
import { isRequiredSessionTargetMethod, mayCreateSessionTarget } from "./session-method-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import {
  expectedSessionMutationTargetError,
  createSessionCreationAuthorizationRecorder,
  assertSessionMutationProjectionCurrent,
  createSessionSharingLookupCaches,
  prepareAuthorizedSessionMutationFacts,
  prepareSessionMutationAuthorizationRequest,
  resolveSessionMutationWriteRoute,
  resolveOwnSessionProfileAuthorization,
  sessionMutationTargetChanged,
  VISIBILITY_AUTHORIZED_METHODS,
  type AuthorizedSessionMutationTarget,
  type SessionMutationAuthorizationParams,
  type SessionSharingLookupCaches,
} from "./session-sharing-authorization.js";
import * as sessionSharingDescribe from "./session-sharing-describe.js";
import {
  withSessionSharingTarget,
  authorizeIncognitoSessionTarget,
  authorizeOwnSessionMutation,
  authorizeSessionAgentRun,
  authorizeSessionSharingTarget,
  hiddenSessionNotFound,
  resolveIncognitoSessionSharingTarget,
  sharingIdentity,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";
import {
  createSessionListEntryFilter,
  createSessionSharingInputAuthority,
  createSessionSharingConsumption,
} from "./session-sharing-read.js";
import {
  captureSessionSharingTalkAuthority,
  isSameSessionSharingSource,
  resolveSessionSharingMembership,
  withPreparedSessionSharingSource,
} from "./session-sharing-source.js";
import {
  readSessionSharingStringParam,
  resolveSessionMutationGuardTarget,
  resolveProtectedSessionTargets,
  resolveSessionMutationTargets,
  resolveTalkSessionTargetInput,
  type SessionMutationTarget,
} from "./session-sharing-target-input.js";
import {
  readProjectedSessionMutationTarget,
  readSessionMutationTarget,
} from "./session-sharing-target-read.js";
import { prepareSessionSharingWorkerGrant } from "./session-sharing-worker-grant.js";
import { assertTalkSessionStorageTarget } from "./talk/session-target.js";
import type { PreparedTalkSessionTarget } from "./talk/session-target.types.js";

export { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";

export {
  canReceiveSessionEvent,
  prepareSessionSharing,
  prepareProjectedSessionSharing,
  createSessionListEntryFilter,
  createProfileSessionEntryFilter,
} from "./session-sharing-read.js";

export {
  allowedSessionVisibilities,
  authorizeIncognitoSessionTarget,
  authorizeResolvedSessionMutation,
  authorizeSessionSharingTarget,
  canAccessIncognitoSession,
  canManageSessionSharing,
  isGatewayAdmin,
  isResolvedIncognitoSession,
  isSessionVisibilityAllowed,
  resolveSessionSharingRole,
  resolveSessionSharingTargetAsync,
  resolveSessionVisibility,
} from "./session-sharing-policy.js";

export function resolveSessionMutationAuthorization(request: SessionMutationAuthorizationParams): {
  authorization?: SessionMutationAuthorization;
  error: ErrorShape | null;
} {
  const requestPreparation = prepareSessionMutationAuthorizationRequest(request);
  if (!requestPreparation.ok) {
    return { error: requestPreparation.error };
  }
  const {
    params,
    authorizesAgentRun,
    authorizesRead,
    bindsProgressLifecycle,
    adminBypass,
    bypassTargetAuthorization,
    targetOwnership,
  } = requestPreparation;
  const memoryBinding = getSessionActorStorageBinding({});
  const withSelectedStorage = <T>(run: () => T): T =>
    memoryBinding ? runWithSessionActorStorage(memoryBinding, run) : run();
  if (bypassTargetAuthorization) {
    return { error: null };
  }
  // The role cap precedes handler visibility filtering on the current exact row.
  if (params.method === "sessions.describe") {
    return { error: sessionSharingDescribe.authorizeSessionDescribe(params) };
  }
  if (params.method === "sessions.list") {
    return { error: null };
  }
  // Resolve runtime config at most once per request and only when a path needs it. The context
  // getter reloads/resolves gateway config, so non-session requests (the vast majority) must not
  // pay it. Group discovery and the authorization loop then share one snapshot, so a mid-request
  // config change cannot split target discovery from authorization.
  let cachedCfg: OpenClawConfig | undefined;
  const getCfg = (): OpenClawConfig => (cachedCfg ??= params.context.getRuntimeConfig());
  const getPolicyConfig = () => params.context.getCommittedRuntimeConfig?.() ?? getCfg();
  const consuming = createSessionSharingConsumption({
    client: params.client,
    sharing: params.preparedSharing,
    getProfiles: () => params.preparedProfiles,
  });
  const { policy: preparedPolicy, consume: consumeSharing } = consuming;
  const sessionCap = (cfg: OpenClawConfig) =>
    consuming.sharing || consuming.profiles
      ? preparedPolicy(cfg)?.sessionCap
      : operatorSessionCap(params.client, cfg);
  const authorizeTargetPolicy = (
    targetRef: SessionMutationTarget,
    target: SessionSharingTarget | null,
    readPolicyConfig: () => OpenClawConfig,
    projection?: SessionRowProjection,
    members?: readonly string[],
    visibilityAuthorized?: boolean,
  ) => {
    const cfg = readPolicyConfig();
    const policy = preparedPolicy(cfg, members);
    const error =
      (target && authorizesAgentRun
        ? authorizeSessionAgentRun(
            { cfg, client: params.client, target },
            policy ? { policy: policy.policy } : undefined,
          )
        : null) ??
      authorizeIncognitoSessionTarget({
        client: params.client,
        sessionKey: targetRef.sessionKey,
        target,
      });
    if (
      error ||
      !target ||
      (visibilityAuthorized ??
        (VISIBILITY_AUTHORIZED_METHODS.has(params.method) &&
          (sessionCap(readPolicyConfig()) ?? "write") === "write"))
    ) {
      return error;
    }
    const identity = sharingIdentity(params.client, resolveGatewayOperatorRoleActor(params.client));
    if (authorizesRead) {
      const entryFilter = policy
        ? policy.entryFilter
        : createSessionListEntryFilter({ cfg, client: params.client });
      return entryFilter?.(target.storeKey, target.entry) === false
        ? hiddenSessionNotFound(target.canonicalKey)
        : null;
    }
    return policy
      ? authorizeSessionSharingTarget(
          { cfg, client: params.client, target, ...targetOwnership },
          {
            value: policy.sessionCap,
            role: policy.roleForTarget(target),
          },
        )
      : authorizeSessionSharingTarget({
          cfg,
          client: params.client,
          target,
          ...targetOwnership,
          isMember: resolveSessionSharingMembership(target, identity?.id, members, projection),
        });
  };
  let lookupCaches: SessionSharingLookupCaches | undefined;
  const resolveAuthorizedTarget = (targetRef: SessionMutationTarget, targetCount: number) => {
    const prepared = params.preparedTargetRead?.(targetRef, getCfg());
    if (prepared) {
      return {
        target: prepared.target,
        members: prepared.members,
        preparedReadSource: prepared.readSource,
      };
    }
    return consuming.sharing
      ? { target: (consuming.sharing.assertCurrent(), consuming.sharing.target) }
      : readSessionMutationTarget({
          ...params,
          cfg: getCfg(),
          targetRef,
          targetCount,
          lookupCaches: () => (lookupCaches ??= createSessionSharingLookupCaches()),
        });
  };
  let talkInput: ReturnType<typeof resolveTalkSessionTargetInput>;
  let talkSessionTarget: PreparedTalkSessionTarget | undefined;
  try {
    talkInput = resolveTalkSessionTargetInput(
      params.method,
      params.requestParams,
      params.client?.connId,
    );
    if (talkInput?.kind === "relay") {
      assertTalkSessionStorageTarget(getCfg(), talkInput.target);
      talkSessionTarget = talkInput.target;
    } else {
      talkSessionTarget = params.preparedTalkSessionTarget;
      if (talkInput && !talkSessionTarget) {
        throw new Error("Talk session target was not prepared");
      }
    }
  } catch (error) {
    return {
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        String(error instanceof Error ? error.message : error),
      ),
    };
  }
  const talkTargets = talkSessionTarget
    ? [{ sessionKey: talkSessionTarget.canonicalKey, agentId: talkSessionTarget.agentId }]
    : undefined;
  const { hidesForeignSessions, protectedTargets } = resolveProtectedSessionTargets({
    client: params.client,
    method: params.method,
    requestParams: params.requestParams,
    adminBypass,
    talkTargets,
    sessionCap: () => sessionCap(getPolicyConfig()),
  });
  for (const targetRef of protectedTargets) {
    const resolved = resolveAuthorizedTarget(targetRef, protectedTargets.length);
    if ("error" in resolved) {
      return { error: resolved.error };
    }
    const target = resolved.target;
    const error = authorizeIncognitoSessionTarget({
      client: params.client,
      sessionKey: targetRef.sessionKey,
      target,
    });
    if (error) {
      return { error };
    }
    if (
      hidesForeignSessions &&
      target &&
      !(
        preparedPolicy(getPolicyConfig())?.isCreator(target.entry.createdActor) ??
        isSessionCreatorProfile(
          target.entry.createdActor,
          params.client?.authenticatedUserProfile?.profileId,
        )
      )
    ) {
      return { error: hiddenSessionNotFound(targetRef.sessionKey) };
    }
  }
  const bindsOwnProfile = params.sessionScope === "operator.sessions.write";
  const ownProfile = resolveOwnSessionProfileAuthorization({
    client: params.client,
    bindsOwnProfile,
  });
  if (ownProfile.error) {
    return { error: ownProfile.error };
  }
  const ownSessionProfileId = ownProfile.profileId;
  const requestedCreateKey = readSessionSharingStringParam(params.requestParams, "key");
  const permitsGeneratedSession = params.method === "sessions.create" && !requestedCreateKey;
  const targetRefs =
    talkTargets ??
    resolveSessionMutationTargets({
      method: params.method,
      requestParams: params.requestParams,
      context: params.context,
    }) ??
    // Creation may not have a row yet, but it must retain its original person until commit.
    (bindsOwnProfile && !isRequiredSessionTargetMethod(params.method) ? [] : undefined);
  if (params.expectedTarget && targetRefs?.length !== 1) {
    return {
      error: sessionMutationTargetChanged(params.method, params.expectedTarget.sessionKey).error,
    };
  }
  if (!targetRefs) {
    if (isRequiredSessionTargetMethod(params.method)) {
      return {
        error: errorShape(ErrorCodes.INVALID_REQUEST, "session mutation target is unavailable", {
          details: { code: "SESSION_MUTATION_TARGET_REQUIRED", method: params.method },
        }),
      };
    }
    return { error: null };
  }
  if (talkSessionTarget && authorizesAgentRun) {
    const cfg = getPolicyConfig();
    const policy = preparedPolicy(cfg);
    const error = authorizeGatewaySessionCreation(
      { cfg, client: params.client, agentId: talkSessionTarget.agentId },
      policy ? { policy: policy.policy } : undefined,
    );
    if (error) {
      return { error };
    }
  }
  const authorizedTargets: AuthorizedSessionMutationTarget[] = [];
  for (const targetRef of targetRefs) {
    const resolved = resolveAuthorizedTarget(targetRef, targetRefs.length);
    if ("error" in resolved) {
      return { error: resolved.error };
    }
    const target = resolved.target;
    if (
      bindsOwnProfile &&
      (params.method === "sessions.patch" || params.method === "sessions.patchMany") &&
      !target
    ) {
      return { error: hiddenSessionNotFound(targetRef.sessionKey) };
    }
    const error =
      expectedSessionMutationTargetError(params.expectedTarget, target, params.method) ??
      authorizeOwnSessionMutation({
        client: params.client,
        target,
        expectedProfileId: ownSessionProfileId,
        isCreator: preparedPolicy(getPolicyConfig())?.isCreator,
      }) ??
      authorizeTargetPolicy(
        targetRef,
        target,
        getPolicyConfig,
        "projection" in resolved ? resolved.projection : undefined,
        "members" in resolved ? resolved.members : undefined,
      );
    if (error) {
      return { error };
    }
    authorizedTargets.push({
      ...targetRef,
      projection: "projection" in resolved ? resolved.projection : undefined,
      resolved: target
        ? {
            agentId: target.agentId,
            canonicalKey: target.canonicalKey,
            storeKey: target.storeKey,
            storePath: target.storePath,
            readSource:
              ("preparedReadSource" in resolved ? resolved.preparedReadSource : undefined) ??
              target.readSource,
          }
        : null,
      sessionId: target?.entry.sessionId?.trim() || null,
      ...(!target &&
      (mayCreateSessionTarget(params.method) || (talkSessionTarget && authorizesAgentRun))
        ? {
            absentTarget: {
              ...(consuming.sharing
                ? consuming.sharing.storageTarget
                : (params.preparedTargetRead?.(targetRef, getCfg())?.storageTarget ??
                  talkSessionTarget ??
                  resolveSessionMutationWriteRoute(getCfg(), targetRef))),
              readSource:
                "preparedReadSource" in resolved ? resolved.preparedReadSource : undefined,
            },
          }
        : {}),
      ...(bindsProgressLifecycle || bindsOwnProfile
        ? { lifecycleRevision: target?.entry.lifecycleRevision }
        : {}),
    });
  }
  return {
    error: null,
    authorization: ((): SessionMutationAuthorization => {
      consuming.sharing = undefined;
      const targetChanged = (sessionKey: string) =>
        sessionMutationTargetChanged(params.method, sessionKey);
      const assertTalkTargetCurrent = captureSessionSharingTalkAuthority({
        request: params,
        input: talkInput,
        target: talkSessionTarget,
        authorizesAgentRun,
        preparedPolicy,
      });
      const assertTargetCurrent = (
        targetRef: SessionMutationTarget,
        expected: AuthorizedSessionMutationTarget | undefined,
        currentCfg: OpenClawConfig,
        _currentLookupCaches?: SessionSharingLookupCaches,
        ensuredSessionId?: string,
        prepared?: { target: SessionSharingTarget | null; members: readonly string[] },
        currentTalkTarget?: PreparedTalkSessionTarget,
      ) => {
        const currentPrepared =
          prepared ??
          (consuming.sharing ? undefined : params.preparedTargetRead?.(targetRef, currentCfg));
        if (!currentPrepared && expected?.absentTarget && !expected.created) {
          const currentRoute = consuming.sharing
            ? consuming.sharing.storageTarget
            : currentTalkTarget &&
                currentTalkTarget.agentId === targetRef.agentId &&
                currentTalkTarget.canonicalKey === targetRef.sessionKey
              ? currentTalkTarget
              : resolveSessionMutationWriteRoute(currentCfg, targetRef);
          // Bind absent rows to their original store before creation can commit.
          if (
            currentRoute.agentId !== expected.absentTarget.agentId ||
            currentRoute.canonicalKey !== expected.absentTarget.canonicalKey ||
            currentRoute.storePath !== expected.absentTarget.storePath
          ) {
            throw targetChanged(targetRef.sessionKey);
          }
        }
        assertSessionMutationProjectionCurrent(expected, params.context, () =>
          targetChanged(targetRef.sessionKey),
        );
        const currentProjection = expected?.projection ?? getSessionRowProjection(params.context);
        const projected =
          !currentPrepared && !consuming.sharing && currentProjection
            ? readProjectedSessionMutationTarget(targetRef, currentCfg, currentProjection)
            : undefined;
        if (expected?.projection && projected?.status === "unavailable") {
          throw targetChanged(targetRef.sessionKey);
        }
        // Pending refreshes retain the captured native identity, never stale membership.
        const current = currentPrepared
          ? currentPrepared.target
          : consuming.sharing
            ? (consuming.sharing.assertCurrent(), consuming.sharing.target)
            : projected?.status === "ready"
              ? projected.target
              : isIncognitoSessionKey(targetRef.sessionKey)
                ? resolveIncognitoSessionSharingTarget({
                    cfg: currentCfg,
                    sessionKey: targetRef.sessionKey,
                    agentId: targetRef.agentId,
                  })
                : (() => {
                    throw targetChanged(targetRef.sessionKey);
                  })();
        // The guarded ensure may mint this row/id. Its result permits only that
        // materialization, never a replacement of an already admitted session.
        const ensuredTarget =
          talkSessionTarget &&
          authorizesAgentRun &&
          expected?.sessionId === null &&
          ensuredSessionId
            ? {
                agentId: talkSessionTarget.agentId,
                canonicalKey: talkSessionTarget.canonicalKey,
                storeKey: talkSessionTarget.canonicalKey,
                storePath: talkSessionTarget.storePath,
              }
            : undefined;
        const expectedResolved = expected?.resolved ?? ensuredTarget;
        const expectedSessionId = expected?.sessionId ?? (ensuredTarget ? ensuredSessionId : null);
        const sameResolvedTarget =
          expected !== undefined &&
          (current === null
            ? expected.resolved === null && !ensuredSessionId
            : expectedResolved !== undefined &&
              expectedResolved !== null &&
              current.agentId === expectedResolved.agentId &&
              current.canonicalKey === expectedResolved.canonicalKey &&
              current.storeKey === expectedResolved.storeKey &&
              isSameSessionSharingSource(current, expectedResolved) &&
              (current.entry.sessionId?.trim() || null) === expectedSessionId &&
              (!(bindsProgressLifecycle || bindsOwnProfile || expected.created) ||
                current.entry.lifecycleRevision === expected.lifecycleRevision));
        if (!sameResolvedTarget) {
          throw targetChanged(targetRef.sessionKey);
        }
        const ownershipError = authorizeOwnSessionMutation({
          client: params.client,
          target: current,
          expectedProfileId: ownSessionProfileId,
          isCreator: preparedPolicy(currentCfg)?.isCreator,
        });
        if (ownershipError) {
          throw new SessionMutationAuthorizationChangedError(ownershipError);
        }
        if (!current) {
          return;
        }
        const policyConfig = params.context.getCommittedRuntimeConfig?.() ?? currentCfg;
        const visibilityAuthorized =
          VISIBILITY_AUTHORIZED_METHODS.has(params.method) &&
          (sessionCap(policyConfig) ?? "write") === "write";
        const error = authorizeTargetPolicy(
          targetRef,
          current,
          () => policyConfig,
          projected?.status === "ready" ? expected?.projection : undefined,
          currentPrepared?.members,
          visibilityAuthorized,
        );
        if (error) {
          throw new SessionMutationAuthorizationChangedError(error);
        }
      };
      const chatTarget =
        params.method === "chat.send" && authorizedTargets.length === 1 && !talkSessionTarget
          ? authorizedTargets[0]
          : undefined;
      const withCurrentSessionSource = chatTarget
        ? async <T>(consume: () => T): Promise<T> => {
            params.preparedProfiles?.readCurrent();
            const cfg = params.context.getRuntimeConfig();
            const assertRoutingCurrent = captureSessionMutationRouting(
              cfg,
              () => targetChanged(chatTarget.sessionKey),
              [chatTarget],
            );
            return withSelectedStorage(() =>
              withSessionSharingTarget(
                { cfg, sessionKey: chatTarget.sessionKey, agentId: chatTarget.agentId },
                (read) =>
                  consumeSharing(
                    {
                      ...read,
                      assertCurrent: () => {
                        read.assertCurrent();
                        assertRoutingCurrent(params.context.getRuntimeConfig());
                      },
                    },
                    () => {
                      assertTargetCurrent(
                        chatTarget,
                        chatTarget,
                        params.context.getRuntimeConfig(),
                      );
                      return consume();
                    },
                  ),
                params.preparedSharing?.selection,
              ),
            );
          }
        : undefined;
      const authorization: SessionMutationAuthorization = {
        ...(params.method === "sessions.move" ||
        params.method === "sessions.dispatch" ||
        ((params.method === "talk.client.create" ||
          params.method === "talk.client.toolCall" ||
          params.method === "talk.session.create") &&
          !authorizedTargets.some((target) => isIncognitoSessionKey(target.sessionKey)))
          ? {
              prepareWorkerGrant: (transactionSource) =>
                withSelectedStorage(() =>
                  prepareSessionSharingWorkerGrant({
                    targets: authorizedTargets,
                    request: params,
                    sourceConfig: getCfg(),
                    authorizesAgentRun,
                    transactionFacts:
                      params.method === "talk.client.create" ||
                      params.method === "talk.client.toolCall" ||
                      params.method === "talk.session.create",
                    transactionSource,
                    consume: (expected, cfg, prepared, profiles) =>
                      consumeSharing(
                        prepared,
                        () => assertTargetCurrent(expected, expected, cfg),
                        profiles,
                      ),
                  }),
                ),
            }
          : {}),
        ...(chatTarget && withCurrentSessionSource
          ? {
              withCurrent: async <T>(consume: () => T): Promise<T> => {
                if (
                  params.preparedTargetRead ||
                  (chatTarget.projection &&
                    chatTarget.resolved &&
                    chatTarget.projection.sharingTargetState({
                      key: chatTarget.resolved.canonicalKey,
                      agentId: chatTarget.resolved.agentId,
                    }).status === "ready")
                ) {
                  return withSelectedStorage(() =>
                    consumeSharing(undefined, () => {
                      authorization.assertCurrent();
                      return consume();
                    }),
                  );
                }
                return withCurrentSessionSource(consume);
              },
              withPreparedCurrent: <T>(
                facts: SessionPendingInputAuthorityFacts,
                consume: () => T,
                assertSourceCurrent: () => void,
              ): T => {
                const expected = authorizedTargets[0]!;
                assertSourceCurrent();
                const prepared = prepareAuthorizedSessionMutationFacts({
                  expected,
                  facts,
                  targetChanged: () => targetChanged(expected.sessionKey),
                });
                const cfg = params.context.getRuntimeConfig();
                const assertRoutingCurrent = captureSessionMutationRouting(
                  cfg,
                  () => targetChanged(expected.sessionKey),
                  [expected],
                );
                return consumeSharing(
                  {
                    ...prepared,
                    members: facts.members,
                    assertCurrent: () => {
                      assertSourceCurrent();
                      assertRoutingCurrent(params.context.getRuntimeConfig());
                    },
                  },
                  () => {
                    assertTargetCurrent(expected, expected, cfg);
                    return consume();
                  },
                );
              },
            }
          : {}),
        ...(talkSessionTarget ? { talkSessionTarget } : {}),
        ...(authorizedTargets.length === 1 &&
        authorizedTargets[0]?.resolved &&
        authorizedTargets[0].sessionId
          ? {
              admittedTarget: Object.freeze({
                agentId: authorizedTargets[0].resolved.agentId,
                sessionKey: authorizedTargets[0].resolved.canonicalKey,
                sessionId: authorizedTargets[0].sessionId,
              }),
            }
          : {}),
        recordCreatedSession: createSessionCreationAuthorizationRecorder({
          targets: authorizedTargets,
          talkSessionTarget,
          permitsGeneratedSession,
        }),
        assertCurrent: withPreparedSessionSharingSource({
          targets: authorizedTargets,
          sourceConfig: getCfg(),
          request: params,
          ownSessionProfileId,
          talk: talkInput,
          assertTalkTargetCurrent,
          assertTargetCurrent,
        }),
        assertTargetCurrent: (targetRef: SessionMutationTarget & { ensuredSessionId?: string }) => {
          const currentCfg = params.context.getRuntimeConfig();
          const { target: normalizedTarget, expected } = resolveSessionMutationGuardTarget(
            params.method,
            currentCfg,
            targetRef,
            authorizedTargets,
          );
          const currentTalkTarget = assertTalkTargetCurrent(currentCfg);
          withSelectedStorage(() =>
            assertTargetCurrent(
              normalizedTarget,
              expected,
              currentCfg,
              undefined,
              targetRef.ensuredSessionId,
              undefined,
              currentTalkTarget,
            ),
          );
        },
      };
      authorization.admittedInputAuthority = createSessionSharingInputAuthority(
        params,
        // Durable input custody needs the source's full transaction facts; ordinary
        // admission segments can consume the projection's committed access facts.
        { ...authorization, withCurrent: withCurrentSessionSource },
        () => consuming.sharing!,
        authorizedTargets,
      );
      return authorization;
    })(),
  };
}
