import type { GitHubPublicationPublisher } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import {
  matchesPreparedGitHubPublicationIdentity,
  prepareGitHubPublicationIdentity,
  prepareGitHubPublicationOptionsIdentity,
  type PreparedGitHubPublicationIdentity,
} from "../agents/github-tool-identity.js";
import { SessionWorktreeSourceChangedError } from "../agents/worktrees/errors.js";
import {
  captureWorktreeRegistryReadGuard,
  readLiveRegistryWorktreeByOwner,
} from "../agents/worktrees/registry-read.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { getRuntimeConfig } from "../config/config.js";
import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import { captureSessionEntryMetadataRead } from "../config/sessions/session-entry-source-authority.js";
import { captureIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LruCache } from "../infra/lru-cache.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { readGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  getSessionRepositoryWorkspaceStore,
  type PreparedRepositoryWorkspace,
} from "../state/session-repository-workspaces.js";
import { requestCurrentGitHubOAuthRefresh } from "./github-oauth-lifecycle.js";
import {
  GitHubPublicationWorkspaceChangedError,
  GitHubPublicationSessionChangedError,
  rejectGitHubPublicationSelection,
  type GitHubPublicationPreparation,
} from "./github-publication-failure.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { retainGatewaySessionEntryReadOnly } from "./session-utils-read-lifetime.js";
import type { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import { loadIncognitoGatewaySessionEntryReadOnly } from "./session-utils.js";

// Discovery only: publication resolves Git afresh. Registry/lifecycle guards retire facts early.
const worktreeTargets = new LruCache<{ expiresAt: number; assertCurrent: () => void }>(256);

function publicationConfigSnapshot() {
  const active = getActiveSecretsRuntimeConfigSnapshot();
  if (active) {
    return active;
  }
  const config = getRuntimeConfig();
  return { config, sourceConfig: config };
}

export function assertExpectedSharedGitHubPublisher(
  expected: GitHubPublicationPublisher | undefined,
  actual: GitHubPublicationPublisher,
  preparation?: GitHubPublicationPreparation,
): void {
  if (
    actual.source === "personal" ||
    (expected &&
      (expected.source !== actual.source ||
        expected.accountId !== actual.accountId ||
        expected.login.toLowerCase() !== actual.login.toLowerCase()))
  ) {
    rejectGitHubPublicationSelection(
      "GitHub publication identity changed; review the current shared account and try again.",
      preparation,
    );
  }
}

export function currentGitHubPublicationConfig() {
  return publicationConfigSnapshot().config;
}

export async function prepareCurrentGitHubPublicationIdentity(
  agentId: string,
): Promise<PreparedGitHubPublicationIdentity> {
  await requestCurrentGitHubOAuthRefresh(agentId);
  const snapshot = publicationConfigSnapshot();
  return await prepareGitHubPublicationIdentity({
    config: snapshot.config,
    sourceConfig: snapshot.sourceConfig,
    agentId,
  });
}

export async function prepareCurrentGitHubPublicationOptionsIdentity(
  agentId: string,
  assertCurrent?: () => void,
) {
  assertCurrent?.();
  await requestCurrentGitHubOAuthRefresh(agentId);
  assertCurrent?.();
  const snapshot = publicationConfigSnapshot();
  return await prepareGitHubPublicationOptionsIdentity({
    config: snapshot.config,
    sourceConfig: snapshot.sourceConfig,
    agentId,
    assertCurrent,
  });
}

export function matchesCurrentGitHubPublicationIdentity(params: {
  agentId: string;
  identity: PreparedGitHubPublicationIdentity;
}): boolean {
  return matchesPreparedGitHubPublicationIdentity({
    config: currentGitHubPublicationConfig(),
    ...params,
  });
}

export type PublicationSessionIdentity = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  lifecycleRevision?: string | null;
};
type ExpectedWorktree = { worktreeId: string; repositoryFingerprint: string; branch: string };
type PublicationSessionRead = Pick<
  Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>>,
  "agentId" | "canonicalKey" | "storePath" | "entry"
>;

/** Process-owned sessions retain their existing synchronous metadata owner. */
function readGitHubPublicationSession(
  sessionKey: string,
  options: { agentId?: string } = {},
): PublicationSessionRead {
  const memory = getSessionActorStorageBinding({ sessionKey, agentId: options?.agentId });
  if (memory) {
    return {
      canonicalKey: sessionKey,
      agentId: memory.agentId,
      storePath: memory.path,
      entry: memory.actor.snapshot(memory.authority)?.entry,
    };
  }
  const binding = captureIncognitoSessionBinding({ sessionKey, agentId: options?.agentId });
  if (!binding) {
    if (isIncognitoSessionKey(sessionKey)) {
      return loadIncognitoGatewaySessionEntryReadOnly(sessionKey, options);
    }
    throw new GitHubPublicationSessionChangedError();
  }
  const { actor } = binding;
  const source = captureSessionEntryMetadataRead({
    sessionKey,
    agentId: actor.agentId,
    storePath: actor.path,
  });
  const metadata = source?.readCurrent();
  return {
    canonicalKey: sessionKey,
    agentId: actor.agentId,
    storePath: actor.path,
    entry: metadata,
  };
}

/** Publication owns its selected metadata until the caller finishes its operation. */
export async function prepareGitHubPublicationSession(
  sessionKey: string,
  options: { agentId?: string; cfg?: OpenClawConfig; assertCurrent?: () => void } = {},
) {
  const scope = { sessionKey, agentId: options.agentId };
  if (
    getSessionActorStorageBinding(scope) ||
    captureIncognitoSessionBinding(scope) ||
    isIncognitoSessionKey(sessionKey)
  ) {
    const initial = readGitHubPublicationSession(sessionKey, options);
    const release = () => {};
    return {
      initial,
      current: () => readGitHubPublicationSession(sessionKey, options),
      release,
      [Symbol.dispose]: release,
    };
  }
  const retained = await retainGatewaySessionEntryReadOnly(
    sessionKey,
    options.agentId,
    () => true,
    options.cfg ?? getRuntimeConfig(),
    { exactRead: true },
  );
  try {
    options.assertCurrent?.();
  } catch (error) {
    retained.release();
    throw error;
  }
  return {
    initial: retained,
    current: (): PublicationSessionRead => {
      options.assertCurrent?.();
      if (!retained.isCurrentAtResponse()) {
        throw new GitHubPublicationSessionChangedError();
      }
      return { ...retained, entry: retained.readRetainedEntry() };
    },
    release: retained.release,
    [Symbol.dispose]: retained.release,
  };
}

function requirePublicationSessionOwner(
  params: PublicationSessionIdentity,
  loaded: PublicationSessionRead,
  allowArchived = false,
) {
  const entry = loaded.entry;
  if (
    loaded.agentId !== params.agentId ||
    loaded.canonicalKey !== params.sessionKey ||
    entry?.sessionId !== params.sessionId ||
    (!allowArchived && entry.archivedAt !== undefined) ||
    (params.lifecycleRevision !== undefined &&
      (entry.lifecycleRevision ?? null) !== params.lifecycleRevision)
  ) {
    throw new GitHubPublicationSessionChangedError();
  }
  return { ...loaded, entry };
}

function requirePublicationWorktreeOwner(
  loaded: ReturnType<typeof requirePublicationSessionOwner>,
  worktree: ManagedWorktreeRecord | undefined,
  expected?: ExpectedWorktree,
) {
  const entry = loaded.entry;
  if (
    !entry.worktree?.id ||
    !worktree ||
    worktree.removedAt !== undefined ||
    worktree.id !== entry.worktree.id ||
    worktree.ownerKind !== "session" ||
    worktree.ownerId !== loaded.canonicalKey ||
    worktree.branch !== entry.worktree.branch ||
    worktree.repoRoot !== entry.worktree.repoRoot
  ) {
    throw new GitHubPublicationSessionChangedError();
  }
  if (
    expected &&
    (worktree.id !== expected.worktreeId ||
      worktree.repoFingerprint !== expected.repositoryFingerprint ||
      worktree.branch !== expected.branch)
  ) {
    throw new GitHubPublicationWorkspaceChangedError(
      "GitHub publication workspace authority changed.",
    );
  }
  return { loaded, worktree };
}

function rejectChangedPublicationWorktree(error: unknown): never {
  if (error instanceof SessionWorktreeSourceChangedError) {
    throw new GitHubPublicationWorkspaceChangedError(error.message);
  }
  throw error;
}

function preparePublicationWorktreeRead(
  loaded: ReturnType<typeof requirePublicationSessionOwner>,
  context: OpenClawStateWorkerContext,
  readCurrent: () => PublicationSessionRead,
  expected?: ExpectedWorktree,
) {
  const identity = {
    sessionId: loaded.entry.sessionId,
    sessionKey: loaded.canonicalKey,
    agentId: loaded.agentId,
    lifecycleRevision: loaded.entry.lifecycleRevision ?? null,
  };
  const workspaceId = loaded.entry.repositoryWorkspaceId;
  const selection = expected ? { ...expected } : undefined;
  return async () => {
    const acceptRead = captureWorktreeRegistryReadGuard(context, "publication");
    const worktree = await readLiveRegistryWorktreeByOwner(context, "session", identity.sessionKey);
    let assertRow: () => void;
    try {
      assertRow = acceptRead(worktree);
    } catch (error) {
      rejectChangedPublicationWorktree(error);
    }
    context.admission.assertCurrent();
    if (!worktree) {
      throw new GitHubPublicationSessionChangedError();
    }
    const current = requirePublicationSessionOwner(identity, readCurrent());
    if (current.entry.repositoryWorkspaceId !== workspaceId) {
      throw new GitHubPublicationSessionChangedError();
    }
    const assertCurrent = () => {
      context.admission.assertCurrent();
      const latest = requirePublicationSessionOwner(identity, readCurrent());
      if (latest.entry.repositoryWorkspaceId !== workspaceId) {
        throw new GitHubPublicationSessionChangedError();
      }
      try {
        assertRow();
      } catch (error) {
        rejectChangedPublicationWorktree(error);
      }
      return requirePublicationWorktreeOwner(latest, worktree, selection);
    };
    return {
      ...requirePublicationWorktreeOwner(current, worktree, selection),
      assertCurrent,
      assertRegistryCurrent: assertRow,
    };
  };
}

export async function readGitHubPublicationWorktreeOwner(
  params: PublicationSessionIdentity & { expected?: ExpectedWorktree },
) {
  const context = captureOpenClawStateWorkerContext();
  const session = await prepareGitHubPublicationSession(params.sessionKey, {
    agentId: params.agentId,
    assertCurrent: () => context.admission.assertCurrent(),
  });
  try {
    const owner = await preparePublicationWorktreeRead(
      requirePublicationSessionOwner(params, session.initial),
      context,
      session.current,
      params.expected,
    )();
    return { ...owner, release: session.release, [Symbol.dispose]: session.release };
  } catch (error) {
    session.release();
    throw error;
  }
}

function resolveGitHubPublicationWorkspaceOwner(
  params: PublicationSessionIdentity,
  prepared: PreparedRepositoryWorkspace | undefined,
  readCurrent: () => PublicationSessionRead,
) {
  const loaded = requirePublicationSessionOwner(params, readCurrent());
  const workspaceId = loaded.entry.repositoryWorkspaceId;
  if (!workspaceId) {
    throw new GitHubPublicationSessionChangedError();
  }
  const workspace = prepared?.current();
  if (
    !workspace ||
    workspace.workspaceId !== workspaceId ||
    workspace.agentId !== params.agentId ||
    workspace.sessionKey !== params.sessionKey
  ) {
    throw new Error("GitHub publication session repository owner changed.");
  }
  return { kind: "repository" as const, loaded, workspace };
}

export async function prepareGitHubPublicationWorkspaceOwner(params: PublicationSessionIdentity) {
  const context = captureOpenClawStateWorkerContext();
  const session = await prepareGitHubPublicationSession(params.sessionKey, {
    agentId: params.agentId,
    assertCurrent: () => context.admission.assertCurrent(),
  });
  try {
    context.admission.assertCurrent();
    const loaded = requirePublicationSessionOwner(params, session.initial);
    const workspaceId = loaded.entry.repositoryWorkspaceId;
    if (!workspaceId && !loaded.entry.worktree?.id) {
      throw new GitHubPublicationSessionChangedError();
    }
    const identity = { ...params, lifecycleRevision: loaded.entry.lifecycleRevision ?? null };
    const readCurrent = session.current;
    const readWorktree = preparePublicationWorktreeRead(loaded, context, readCurrent);
    const prepared = workspaceId
      ? await getSessionRepositoryWorkspaceStore().prepare(workspaceId)
      : undefined;
    const validate = <T extends { loaded: ReturnType<typeof requirePublicationSessionOwner> }>(
      owner: T,
    ) => {
      context.admission.assertCurrent();
      if (owner.loaded.entry.repositoryWorkspaceId !== workspaceId) {
        throw new GitHubPublicationSessionChangedError();
      }
      return owner;
    };
    const read = async () =>
      validate(
        workspaceId
          ? resolveGitHubPublicationWorkspaceOwner(identity, prepared, readCurrent)
          : { kind: "worktree" as const, ...(await readWorktree()) },
      );
    return {
      initial: await read(),
      read,
      // Only repository owners expose synchronous current facts; worktrees use the worker reader.
      currentRepository: () =>
        validate(resolveGitHubPublicationWorkspaceOwner(identity, prepared, readCurrent)),
      release: session.release,
      [Symbol.dispose]: session.release,
    };
  } catch (error) {
    session.release();
    throw error;
  }
}

export function sameGitHubPublicationWorkspace(
  first: Awaited<ReturnType<typeof prepareGitHubPublicationWorkspaceOwner>>["initial"],
  current: Awaited<ReturnType<typeof prepareGitHubPublicationWorkspaceOwner>>["initial"],
): boolean {
  if (first.loaded.entry?.lifecycleRevision !== current.loaded.entry?.lifecycleRevision) {
    return false;
  }
  return first.kind === "repository"
    ? current.kind === "repository" &&
        current.workspace.workspaceId === first.workspace.workspaceId &&
        current.workspace.url === first.workspace.url &&
        current.workspace.branch === first.workspace.branch
    : current.kind === "worktree" &&
        current.worktree.id === first.worktree.id &&
        current.worktree.repoFingerprint === first.worktree.repoFingerprint &&
        current.worktree.branch === first.worktree.branch;
}

function localGitHubPublicationSessionIdentity(row: {
  request_id: string;
  identity_source: string;
  session_id: string;
  session_key: string;
  agent_id: string;
  worktree_id: string;
  repository_fingerprint: string;
  branch: string;
}) {
  const lifecycle = readGitHubPublicationSessionLifecycle({
    publicationKind: row.identity_source === "personal" ? "personal" : "shared",
    requestId: row.request_id,
  });
  if (!lifecycle) {
    throw new GitHubPublicationSessionChangedError();
  }
  return {
    sessionId: row.session_id,
    sessionKey: row.session_key,
    agentId: row.agent_id,
    lifecycleRevision: lifecycle.lifecycle_revision,
    expected: {
      worktreeId: row.worktree_id,
      repositoryFingerprint: row.repository_fingerprint,
      branch: row.branch,
    },
  };
}

export async function readLocalGitHubPublicationWorktreeOwner(
  row: Parameters<typeof localGitHubPublicationSessionIdentity>[0],
) {
  const identity = localGitHubPublicationSessionIdentity(row);
  const owner = await readGitHubPublicationWorktreeOwner(identity);
  return {
    ...owner,
    assertCurrent: () => {
      if (
        localGitHubPublicationSessionIdentity(row).lifecycleRevision !== identity.lifecycleRevision
      ) {
        throw new GitHubPublicationSessionChangedError();
      }
      return owner.assertCurrent();
    },
  };
}

/** Discovery validates the same registered repository identity as publication, without GitHub I/O. */
export async function prepareGitHubPublicationRepositoryIdentity(params: {
  worktree: ManagedWorktreeRecord;
  assertCurrent: () => void;
}) {
  const { worktree, assertCurrent } = params;
  assertCurrent();
  const repositoryIdentity = await managedWorktrees.resolveRepositoryIdentity(worktree.path);
  assertCurrent();
  if (
    repositoryIdentity.checkoutRoot !== worktree.path ||
    repositoryIdentity.repoRoot !== worktree.repoRoot ||
    repositoryIdentity.fingerprint !== worktree.repoFingerprint
  ) {
    throw new GitHubPublicationWorkspaceChangedError(
      "GitHub publication workspace repository changed.",
    );
  }
  return repositoryIdentity;
}

function isSupportedGitHubOrigin(originUrl: string): boolean {
  const remote = parseGitHubRemoteUrl(originUrl);
  return Boolean(
    remote && /^[A-Za-z0-9_.-]+$/u.test(remote.owner) && /^[A-Za-z0-9_.-]+$/u.test(remote.repo),
  );
}

/** Qualify only the target; execution still owns branch, permission and publication checks. */
export async function hasSupportedGitHubPublicationTarget(
  session: PublicationSessionIdentity,
  assertCurrent: () => void,
): Promise<boolean> {
  assertCurrent();
  const context = captureOpenClawStateWorkerContext();
  using preparedSession = await prepareGitHubPublicationSession(session.sessionKey, {
    agentId: session.agentId,
    assertCurrent,
  });
  const initial = requirePublicationSessionOwner(session, preparedSession.initial, true);
  context.admission.assertCurrent();
  if (initial.entry.archivedAt !== undefined) {
    return false;
  }
  const workspaceId = initial.entry.repositoryWorkspaceId;
  if (workspaceId) {
    const prepared = await getSessionRepositoryWorkspaceStore().prepare(workspaceId);
    assertCurrent();
    const owner = resolveGitHubPublicationWorkspaceOwner(
      session,
      prepared,
      preparedSession.current,
    );
    return isSupportedGitHubOrigin(owner.workspace.url);
  }
  if (!initial.entry.worktree?.id) {
    return false;
  }
  const owner = await preparePublicationWorktreeRead(initial, context, preparedSession.current)();
  const assertWorktreeCurrent = () => {
    assertCurrent();
    owner.assertCurrent();
  };
  assertWorktreeCurrent();
  const key = `${context.admission.databasePath}\0${owner.worktree.id}`;
  const cached = worktreeTargets.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    try {
      cached.assertCurrent();
      return true;
    } catch {
      // The current read may select a replacement owner; qualify its Git facts again.
    }
  }
  worktreeTargets.delete(key);
  const repository = await prepareGitHubPublicationRepositoryIdentity({
    worktree: owner.worktree,
    assertCurrent: assertWorktreeCurrent,
  });
  assertWorktreeCurrent();
  const supported = isSupportedGitHubOrigin(repository.originUrl);
  if (supported) {
    worktreeTargets.set(key, {
      expiresAt: Date.now() + 15_000,
      assertCurrent: owner.assertRegistryCurrent,
    });
  }
  return supported;
}
