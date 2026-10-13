import type { ApprovalHandler } from "@muse-code/sdk";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

export type MuseApprovalRequest = Parameters<ApprovalHandler>[0];

export function selectApprovalChoice(
  request: MuseApprovalRequest,
  decision: string | null | undefined,
) {
  const wanted = decision === "allow-once" ? "approved" : "denied";
  const choice =
    request.availableChoices.find(
      (candidate) => candidate.decision === wanted && candidate.scope === "once",
    ) ??
    (wanted === "denied"
      ? request.availableChoices.find(
          (candidate) => candidate.decision === "denied" || candidate.decision === "abort",
        )
      : undefined);
  if (!choice) {
    throw new Error(`Muse offered no safe ${wanted} approval choice`);
  }
  return { choiceId: choice.choiceId };
}

export function createApprovalHandler(params: AgentHarnessAttemptParamsV2): ApprovalHandler {
  return async (request) => {
    params.hostCapabilities.assertActive();
    const answer = await params.hostCapabilities.requestApproval({
      title: `Muse: ${request.toolName}`,
      description: request.subject.command ?? request.subject.path ?? request.toolName,
      detail: request.rawArgs,
      toolName: request.toolName,
      toolCallId: request.toolCallId,
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      timeoutMs: params.timeoutMs,
      signal: params.abortSignal,
    });
    let decision = answer?.decision;
    if (answer?.id && decision == null) {
      decision = (
        await params.hostCapabilities.waitForApproval({
          approvalId: answer.id,
          timeoutMs: params.timeoutMs,
          signal: params.abortSignal,
        })
      )?.decision;
    }
    params.hostCapabilities.assertActive();
    params.abortSignal?.throwIfAborted();
    return selectApprovalChoice(request, decision);
  };
}
