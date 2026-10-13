import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { logVerbose } from "../../globals.js";
import {
  borrowOpenClawAgentDatabase,
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  createAgentTurnCompletionProjector,
  withAgentTurnCompletionSettlement,
} from "./agent-runner-completion.shared.js";
import type { AgentTurnCompletion } from "./agent-runner-completion.types.js";

/** Native incognito keeps its existing in-process entry owner until its worker cutover. */
export async function withNativeIncognitoTurnCompletion<T>(
  params: {
    agentId?: string;
    storePath: string;
    sessionKey: string;
    writer: Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "activeWriterRunId">;
    assertCurrent(): void;
    publish(entry: SessionEntry): void;
  },
  consume: (completion: AgentTurnCompletion) => Promise<T>,
): Promise<{ value: T } | undefined> {
  const scope = resolveSqliteScope(params);
  const options = toDatabaseOptions(scope);
  const pathname = resolveOpenClawAgentSqlitePath(options);
  if (
    !isIncognitoOpenClawAgentSqlitePath(pathname, options) ||
    captureIncognitoSessionSource(params)
  ) {
    return undefined;
  }
  const owner = getOpenClawAgentDatabaseIfOpen(options);
  if (!owner) {
    throw new Error("Terminal accounting session is unavailable");
  }
  const retained = borrowOpenClawAgentDatabase(options);
  const assertCurrent = () => {
    params.assertCurrent();
    if (getOpenClawAgentDatabaseIfOpen(options) !== owner) {
      throw new Error("Terminal accounting lost its native incognito owner");
    }
  };
  const assertEntry = (entry: SessionEntry | undefined): SessionEntry => {
    if (
      !entry ||
      entry.sessionId !== params.writer.sessionId ||
      entry.lifecycleRevision !== params.writer.lifecycleRevision ||
      entry.activeWriterRunId !== params.writer.activeWriterRunId
    ) {
      throw new Error("Terminal accounting session changed");
    }
    return entry;
  };
  try {
    assertCurrent();
    let snapshot = assertEntry(loadSessionEntry(params));
    const { project, patch } = createAgentTurnCompletionProjector();
    let finished = false;
    const refresh = async () => {
      assertCurrent();
      snapshot = assertEntry(loadSessionEntry(params));
      return project(snapshot).entry;
    };
    const completion: AgentTurnCompletion = {
      current: () => project(snapshot).entry,
      assertCurrent() {
        assertCurrent();
        return assertEntry(loadSessionEntry(params));
      },
      refresh,
      patch,
      async complete(pendingFinalDelivery) {
        if (finished) {
          return snapshot;
        }
        finished = true;
        await refresh();
        const { reducers } = project(snapshot);
        if (reducers.length === 0 && !pendingFinalDelivery) {
          return snapshot;
        }
        let committed = false;
        try {
          const result = await patchSessionEntryCore(
            params,
            (entry) => ({
              ...project(assertEntry(entry)).entry,
              ...(pendingFinalDelivery ? { pendingFinalDelivery, updatedAt: Date.now() } : {}),
            }),
            {
              skipMaintenance: true,
              assertCommitAllowed: assertCurrent,
              onCommitted(entry) {
                committed = true;
                snapshot = entry;
                params.publish(entry);
              },
            },
          );
          if (!result) {
            throw new Error("Terminal accounting session is unavailable");
          }
          return snapshot;
        } catch (error) {
          await refresh();
          if (
            committed ||
            pendingFinalDelivery ||
            !reducers.every((reducer) => reducer.kind === "usage")
          ) {
            throw error;
          }
          logVerbose(`failed to persist usage update: ${String(error)}`);
          return snapshot;
        }
      },
    };
    const value = await withAgentTurnCompletionSettlement(completion, consume);
    return { value };
  } finally {
    retained.release();
  }
}
