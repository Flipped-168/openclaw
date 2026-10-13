import type { SessionActorReducer } from "../../config/sessions/session-actor-contract.js";
import { reduceSessionActorEntry } from "../../config/sessions/session-actor-reducers.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { AgentTurnCompletion } from "./agent-runner-completion.types.js";

export function createAgentTurnCompletionProjector() {
  // Accounting supplies reducers before completion; late internal patches are not persisted.
  const prepared: Parameters<AgentTurnCompletion["patch"]>[0][] = [];
  const project = (entry: SessionEntry) => {
    let next = structuredClone(entry);
    const reducers: SessionActorReducer[] = [];
    for (const preparation of prepared) {
      const reducer = typeof preparation === "function" ? preparation(next) : preparation;
      if (reducer) {
        reducers.push(reducer);
        next = reduceSessionActorEntry(next, [reducer]);
      }
    }
    return { entry: next, reducers };
  };
  return {
    project,
    patch: (reducer: Parameters<AgentTurnCompletion["patch"]>[0]) => prepared.push(reducer),
  };
}

export async function withAgentTurnCompletionSettlement<T>(
  completion: AgentTurnCompletion,
  consume: (completion: AgentTurnCompletion) => Promise<T>,
): Promise<T> {
  let value: T;
  try {
    value = await consume(completion);
  } catch (error) {
    try {
      await completion.complete();
    } catch (settlementError) {
      throw new AggregateError([error, settlementError], "Terminal accounting failed to settle", {
        cause: settlementError,
      });
    }
    throw error;
  }
  await completion.complete();
  return value;
}
