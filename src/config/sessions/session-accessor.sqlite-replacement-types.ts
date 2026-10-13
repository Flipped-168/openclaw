import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-admission-contract.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type { ResolvedSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import type {
  SessionEntryMaintenanceInput,
  SessionEntryMaintenancePlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import type { SessionEntryReplacement, TranscriptEvent } from "./session-accessor.types.js";
import type { SessionOwnerAssignment } from "./session-entry-provenance.js";
import type { SessionNativeBindingParticipants } from "./session-native-binding.types.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import type { SessionEntry } from "./types.js";

export type SessionEntryWorkerPreparation = (
  execution: OpenClawAgentDatabaseExecution,
  source: AgentDatabaseRequestExecutionSource,
) => {
  prepare: () => Promise<void>;
  beforeWrite: () => void;
  release: () => Promise<void>;
};

export type SessionEntryWorkerMutationResult<T> =
  | { kind: "committed"; value: T; publication: SessionEntryReplacementPublication }
  | { kind: "not-committed"; value: T };

export type SqliteSessionEntryReplacement = SessionEntryReplacement & {
  previousSessionKeys?: readonly string[];
};

export type SessionEntryReplacementCommit = {
  sources?: SessionSourcePredicate[];
  nativeBindings?: SessionNativeBindingParticipants;
  expectedRows: Map<string, ResolvedSessionEntryRow>;
  labelOwnerKeys: string[];
  includeLabelOwners?: string;
  labelClaim?: { sessionKey: string; label: string };
  preparedTranscript?: {
    sessionKey: string;
    sessionId: string;
    events: readonly TranscriptEvent[];
  };
  validationKeys: string[];
  replacements: SqliteSessionEntryReplacement[];
  checkPendingArchiveRecovery?: boolean;
  consumePendingReset?: boolean;
  maintenance?: SessionEntryMaintenanceInput;
  ownerAssignment?: { sessionKey: string; owner: SessionOwnerAssignment };
};

export type SessionEntryReplacementCommitted = {
  pendingArchiveRecovery: boolean;
  previous: Map<string, SessionEntry>;
  current: Map<string, SessionEntry>;
  maintenancePlans: SessionEntryMaintenancePlan[];
  membershipInvalidatedKeys: string[];
};

export type SessionEntryReplacementCandidate = {
  kind: "session-entry-replacements";
  result: SessionEntryReplacementCommitted;
  publication: SessionEntryReplacementPublication;
};
