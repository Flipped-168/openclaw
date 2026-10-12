import path from "node:path";
import { readPreparedSessionEntryChange } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  projectSessionSharingEntry,
  retainPreparedSessionSharingFacts,
  type SessionEntryPlaceholder,
} from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import type { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import { SessionMutationFactsUnavailableError } from "./session-sharing-incognito.js";
import type { PreparedSessionMutationFacts } from "./session-sharing-policy.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

export type PreparedSessionSourceFacts = PreparedSessionMutationFacts & {
  /** Physical source retained by the same read custody as the sharing facts. */
  sourcePath?: string;
  sourceAgentId?: string;
  /** An absent row still retains the physical source that proved its absence. */
  readSource?: CapturedSessionEntryReadSource;
};

export type ExistingSessionMutationFacts = PreparedSessionSourceFacts & {
  target: NonNullable<PreparedSessionMutationFacts["target"]>;
};

export type CommittedSessionMutationTarget = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  sessionId: string;
  lifecycleRevision?: string;
  readSource?: CapturedSessionEntryReadSource;
};

type RetainedSharingRead = ReturnType<typeof retainPreparedSessionSharingFacts>;

/** Retain one sharing row, promoting absent/idless facts only from its creator's COMMIT. */
export function createSessionSharingReceiptRead({
  selected,
  canonicalKey,
  allowMissing,
  match,
  sharing,
  sourceIdentities,
  retainedReads,
  selectedPaths,
  preparedSources,
  releases,
  getExpectedPlaceholder,
  setExpectedPlaceholder,
  onCreatedFacts,
}: {
  selected: GatewaySessionStoreTarget;
  canonicalKey: string;
  allowMissing?: true;
  match: { entry: SessionEntry; key: string } | undefined;
  sharing: Awaited<ReturnType<typeof readSessionEntriesFromStoreInWorker>>["sharing"];
  sourceIdentities: ReadonlyMap<string, CapturedSessionEntryReadSource>;
  retainedReads: Map<string, RetainedSharingRead>;
  selectedPaths: Set<string>;
  preparedSources: Array<{ agentId: string; path: string; identity: string; birthtime: string }>;
  releases: Array<() => void>;
  getExpectedPlaceholder: () => SessionEntryPlaceholder | undefined;
  setExpectedPlaceholder: (placeholder: SessionEntryPlaceholder | undefined) => void;
  onCreatedFacts: (facts: PreparedSessionSourceFacts) => void;
}) {
  let readFacts: () => PreparedSessionSourceFacts;
  let acknowledgedCreation: { databaseIdentity: string; sessionId: string } | undefined;
  let captureCreatedPublication = (_change: SessionRowChange): boolean => false;
  let recordCreated: ((created: CommittedSessionMutationTarget) => void) | undefined;
  if (!match) {
    if (!allowMissing) {
      throw new SessionMutationFactsUnavailableError();
    }
    const retained = sharing && retainedReads.get(`${sharing.databaseIdentity}\0${canonicalKey}`);
    setExpectedPlaceholder(retained?.readCurrent()?.placeholder);
    readFacts = () => {
      const current = retained?.readCurrent();
      if (
        (retained && !current) ||
        current?.entry ||
        current?.placeholder?.sessionId !== getExpectedPlaceholder()?.sessionId
      ) {
        throw new SessionMutationFactsUnavailableError();
      }
      return {
        target: null,
        membership: new Set<string>(),
        readSource: sourceIdentities.get(selected.storePath),
      };
    };
  } else {
    if (!sharing) {
      throw new SessionMutationFactsUnavailableError();
    }
    const target = {
      agentId: selected.agentId,
      canonicalKey: selected.canonicalKey,
      storePath: selected.storePath,
      readSource: sourceIdentities.get(selected.storePath),
      storeKeys: selected.storeKeys,
      entry: projectSessionSharingEntry(match.entry),
      storeKey: match.key,
    };
    const retained = retainedReads.get(`${sharing.databaseIdentity}\0${target.storeKey}`);
    if (!retained) {
      throw new SessionMutationFactsUnavailableError();
    }
    readFacts = () => {
      const current = retained.readCurrent();
      if (!current?.entry) {
        throw new SessionMutationFactsUnavailableError();
      }
      return {
        sourcePath: sharing.source.path,
        sourceAgentId: sharing.source.agentId,
        target: { ...target, entry: current.entry },
        membership: current.membership,
      };
    };
  }
  if (allowMissing && !match?.entry.sessionId) {
    // Hold the write receipt without adopting another creator's row. Only this
    // request's acknowledged COMMIT may promote its original absent/idless target.
    let pendingCreated:
      | {
          source: CapturedSessionEntryReadSource & { databaseIdentity: string };
          retained: ReturnType<typeof retainPreparedSessionSharingFacts>;
        }
      | undefined;
    let committedCreation: CommittedSessionMutationTarget | undefined;
    captureCreatedPublication = (change) => {
      if (
        !("sessionKey" in change) ||
        !change.storePath ||
        !selectedPaths.has(path.resolve(change.storePath))
      ) {
        return false;
      }
      const published = readPreparedSessionEntryChange(change, canonicalKey);
      if (
        !published?.sharing ||
        !published.projection ||
        typeof published.source.identity !== "string" ||
        published.source.birthtime === undefined
      ) {
        return false;
      }
      const source: CapturedSessionEntryReadSource & { databaseIdentity: string } = {
        agentId: selected.agentId,
        path: published.source.filename,
        databaseIdentity: published.source.identity,
        databaseBirthtime: published.source.birthtime,
      };
      const identity = `file:${published.source.identity}`;
      const key = `${identity}\0${canonicalKey}`;
      const retained = retainPreparedSessionSharingFacts({
        databaseIdentity: identity,
        sessionKey: canonicalKey,
        entry: published.sharing,
        membership: new Set(published.projection.membership[2]),
      });
      retainedReads.get(key)?.release();
      retainedReads.set(key, retained);
      releases.push(retained.release);
      pendingCreated = { source, retained };
      if (!preparedSources.some((prepared) => prepared.path === source.path)) {
        preparedSources.push({
          agentId: source.agentId,
          path: source.path,
          identity,
          birthtime: published.source.birthtime,
        });
      }
      if (committedCreation) {
        recordCreated?.(committedCreation);
      }
      return true;
    };
    recordCreated = (created) => {
      if (
        created.agentId !== selected.agentId ||
        created.sessionKey !== canonicalKey ||
        created.storePath !== selected.storePath
      ) {
        throw new SessionMutationFactsUnavailableError();
      }
      // The writer may allocate a suffixed store after absence was captured.
      if (created.readSource) {
        selectedPaths.add(path.resolve(created.readSource.path));
      }
      const pending = pendingCreated;
      if (!pending) {
        // The writer acknowledges COMMIT before publishing its postimage to observers.
        committedCreation = {
          ...created,
          ...(created.readSource ? { readSource: { ...created.readSource } } : {}),
        };
        return;
      }
      const current = pending.retained.readCurrent();
      if (
        !current?.entry ||
        created.sessionId !== current.entry.sessionId ||
        created.lifecycleRevision !== current.entry.lifecycleRevision ||
        (created.readSource &&
          (created.readSource.databaseIdentity !== pending.source.databaseIdentity ||
            created.readSource.databaseBirthtime !== pending.source.databaseBirthtime))
      ) {
        throw new SessionMutationFactsUnavailableError();
      }
      if (created.readSource) {
        // Shared stores may have a different physical owner than the session's logical agent.
        pending.source = { ...pending.source, agentId: created.readSource.agentId };
        const prepared = preparedSources.find((source) => source.path === pending.source.path);
        if (prepared) {
          prepared.agentId = created.readSource.agentId;
        }
      }
      const target = {
        agentId: selected.agentId,
        canonicalKey,
        storeKey: canonicalKey,
        storeKeys: selected.storeKeys,
        storePath: selected.storePath,
        readSource: pending.source,
      };
      readFacts = () => {
        const latest = pending.retained.readCurrent();
        if (!latest?.entry) {
          throw new SessionMutationFactsUnavailableError();
        }
        return {
          target: { ...target, entry: latest.entry },
          membership: latest.membership,
          sourcePath: pending.source.path,
          sourceAgentId: pending.source.agentId,
        };
      };
      acknowledgedCreation = {
        sessionId: created.sessionId,
        databaseIdentity: pending.source.databaseIdentity,
      };
      captureCreatedPublication = () => false;
      recordCreated = undefined;
      onCreatedFacts(readFacts());
    };
  }

  return {
    read: () => readFacts(),
    captureCreatedPublication: (change: SessionRowChange) => captureCreatedPublication(change),
    recordCreated: (created: CommittedSessionMutationTarget) => {
      if (!recordCreated) {
        return undefined;
      }
      recordCreated(created);
      return acknowledgedCreation ? readFacts() : undefined;
    },
    acknowledgesIdentityMutation: (change: SessionIdentityMutation) =>
      // The creator already installed this idless-to-id COMMIT receipt.
      Boolean(
        acknowledgedCreation &&
        !change.previous.sessionId &&
        "current" in change &&
        change.current.sessionId === acknowledgedCreation.sessionId &&
        change.databaseIdentity === acknowledgedCreation.databaseIdentity,
      ),
  };
}

/** A generated target is first known inside its creator's pre-publication COMMIT callback. */
export function retainCreatedSessionMutationFacts(params: {
  created: CommittedSessionMutationTarget;
  assertRoutingCurrent: (cfg: OpenClawConfig) => void;
  onCaptured: (created: CommittedSessionMutationTarget) => void;
}) {
  const created = { ...params.created };
  const selected = {
    agentId: created.agentId,
    canonicalKey: created.sessionKey,
    storePath: created.storePath,
    storeKeys: [created.sessionKey],
  };
  const releases: Array<() => void> = [];
  const selectedPaths = new Set([path.resolve(created.storePath)]);
  let active = true;
  let expectedPlaceholder: SessionEntryPlaceholder | undefined;
  const release = () => {
    if (!active) {
      return;
    }
    active = false;
    for (const dispose of releases.splice(0)) {
      dispose();
    }
  };
  const receipt = createSessionSharingReceiptRead({
    selected,
    canonicalKey: created.sessionKey,
    allowMissing: true,
    match: undefined,
    sharing: undefined,
    sourceIdentities: new Map(),
    retainedReads: new Map(),
    selectedPaths,
    preparedSources: [],
    releases,
    getExpectedPlaceholder: () => expectedPlaceholder,
    setExpectedPlaceholder: (value) => {
      expectedPlaceholder = value;
    },
    onCreatedFacts: (facts) => {
      const readSource = facts.target?.readSource;
      if (!readSource) {
        throw new SessionMutationFactsUnavailableError();
      }
      releases.push(
        registerOpenClawAgentDatabaseAsyncResource({
          agentId: created.agentId,
          path: readSource.path,
          revoke: release,
          close: async () => release(),
        }),
      );
      params.onCaptured({ ...created, readSource });
    },
  });
  receipt.recordCreated(created);
  const stop = sessionChanges.subscribeFacts((change) => {
    if (
      !("sessionKey" in change) ||
      change.sessionKey !== created.sessionKey ||
      (change.agentId && change.agentId !== created.agentId)
    ) {
      return;
    }
    const published = readPreparedSessionEntryChange(change, created.sessionKey);
    if (
      !change.storePath ||
      published?.sharing?.sessionId !== created.sessionId ||
      published.sharing.lifecycleRevision !== created.lifecycleRevision
    ) {
      return;
    }
    // The creator's exact receipt supplies the allocated physical path, including gaps.
    selectedPaths.add(path.resolve(change.storePath));
    if (receipt.captureCreatedPublication(change)) {
      stop();
    }
  });
  releases.push(stop);
  return {
    storageTarget: selected,
    bindCreation() {
      throw new SessionMutationFactsUnavailableError();
    },
    readCurrent(cfg: OpenClawConfig) {
      if (!active) {
        throw new SessionMutationFactsUnavailableError();
      }
      params.assertRoutingCurrent(cfg);
      const facts = receipt.read();
      if (!facts.target) {
        throw new SessionMutationFactsUnavailableError();
      }
      return facts;
    },
    release,
  };
}
