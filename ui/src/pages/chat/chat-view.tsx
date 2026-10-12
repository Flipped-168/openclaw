import type { Component } from "solid-js";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import type {
  SessionPlacementDiskSpace,
  SessionPlacementWorkerRuntimeInstall,
  SessionSharingRole,
  SessionSuggestion,
  SessionSuggestionResolution,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ControlUiSurfaceProps } from "../../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../../app/context-types.ts";
import type { ExecApprovalDecision, ExecApprovalRequest } from "../../app/exec-approval.ts";
import { ExecApprovalCard } from "../../components/exec-approval-card-solid.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../../lib/keyboard-shortcut-contract.ts";
import { ApplicationProvider, useOptionalApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { scopedSessionArtifactKey } from "../../lib/sessions/session-key.ts";
import {
  PRESENTATION_CHANGED_EVENT,
  type PresentationValue,
} from "../../lit/presentation-binding.ts";
import { LitContent, solidContent, emptyLegacyContent } from "../../lit/solid-content.tsx";
import { PluginContributions } from "../../plugins/control-ui-contributions.solid.tsx";
import { PluginView } from "../../plugins/control-ui-view.solid.tsx";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatPendingInputs } from "./chat-pending-inputs.ts";
import type { ChatProviderReviewController } from "./chat-provider-review-controller.tsx";
import type { ChatRunStartupStatus } from "./chat-run-startup.ts";
import { forwardChatWheelToTranscript } from "./chat-scroll-input.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { createChatViewFrame, type ChatViewFrame } from "./chat-view-frame.ts";
import {
  type ChatPlacementStartupNoticeProps,
  renderChatComposerNotices as ChatComposerNoticesView,
  renderChatTopbarNotices,
} from "./chat-view-notices.tsx";
import { ChatCommentController } from "./components/chat-comment-controller.ts";
import {
  renderComposerQuestionDock,
  resolveComposerQuestionPanel,
} from "./components/chat-composer-question.ts";
import { getChatComposerState, hasTerminalRunStatus } from "./components/chat-composer-state.ts";
import type { ChatComposerProps } from "./components/chat-composer-types.ts";
import { renderChatComposerQueue } from "./components/chat-composer-view.ts";
import { renderChatComposer } from "./components/chat-composer.ts";
import type { ChatDetailsProps } from "./components/chat-details-types.ts";
import { isImageLightboxEvent, openInlineChatImage } from "./components/chat-image-lightbox.ts";
import { renderChatPullRequests } from "./components/chat-pull-requests.ts";
import { renderChatSelectionAnnotations } from "./components/chat-selection-annotations.ts";
import { renderChatSessionSuggestions } from "./components/chat-session-suggestions.ts";
import { renderChatSwarmProgress } from "./components/chat-swarm-progress.ts";
import {
  renderChatTaskSuggestionTray,
  type ChatTaskSuggestionTrayProps,
} from "./components/chat-task-suggestions.ts";
import {
  renderTranscriptSearch,
  toggleTranscriptSearch,
  type ChatThreadProps,
} from "./components/chat-thread-interactions.ts";
import { ChatThread } from "./components/chat-thread-view.tsx";
import type { ChatTranscriptController } from "./components/chat-transcript-controller.ts";
import type { ProviderPolicyNotice } from "./tool-stream-contract.ts";
import type { WorkspaceResultConflict } from "./workspace-conflict.ts";
import "../../components/resizable-divider.ts";
export type ChatProps = Omit<
  ChatThreadProps,
  | "pendingInputs"
  | "runActive"
  | "runWorking"
  | "startupLabel"
  | "questionPrompts"
  | "agents"
  | "queuedMessageAction"
  | "onRetryQueuedMessage"
  | "onDiscardQueuedMessage"
  | "onFocusComposer"
  | "commentAttachments"
  | "commentsDisabled"
  | "onAddToChat"
  | "onCompanionSelection"
  | "onOpenSession"
  | "onSend"
> &
  Omit<ChatComposerProps, "notices" | "footerContent" | "disabled" | "onOpenImage"> &
  ChatDetailsProps &
  ChatTaskSuggestionTrayProps &
  ChatPlacementStartupNoticeProps & {
    onCompanionStageAttachment?: (attachment: ChatAttachment, sourceSessionKey: string) => boolean;
    transcript: ChatTranscriptController;
    asyncQuestionStorage?:
      | import("../../lib/chat/composer-draft-store.runtime.ts").DurableComposerDraftScope
      | null;
    onAsyncQuestionSubmit?: (
      message: string,
      itemId?: string,
      sourceMessageId?: string,
    ) => Promise<boolean>;
    presented?: PresentationValue;
    historyState?: ChatState;
    startupStatus?: ChatRunStartupStatus | null;
    providerPolicyNotice?: ProviderPolicyNotice | null;
    providerReview?: ChatProviderReviewController;
    providerReviewRevision?: object;
    error: string | null;
    diskSpace?: SessionPlacementDiskSpace;
    workerRuntimeInstall?: SessionPlacementWorkerRuntimeInstall;
    inlineApproval?: ExecApprovalRequest | null;
    approvalBusy?: boolean;
    approvalCanGrant: boolean;
    approvalErrors?: ReadonlyMap<string, string>;
    onApprovalDecision?: (
      approvalId: string,
      decision: ExecApprovalDecision,
    ) => void | Promise<void>;
    workspaceConflict?: WorkspaceResultConflict;
    onDismissWorkspaceConflict?: () => void;
    swarm?: Parameters<typeof renderChatSwarmProgress>[0];
    chatMessageMaxWidth?: string | null;
    showNewMessages?: boolean;
    onScrollToBottom?: (options?: { smooth?: boolean }) => void;
    onRefresh: () => void;
    onDismissError?: () => void;
    agentsList: {
      agents: Array<{
        id: string;
        name?: string;
        identity?: { name?: string; avatarUrl?: string };
      }>;
      defaultId?: string;
    } | null;
    sessionSuggestions?: readonly SessionSuggestion[];
    sessionSuggestionRole?: SessionSharingRole;
    sessionSuggestionBusyIds?: ReadonlySet<string>;
    sessionSuggestionsArchived?: boolean;
    canResolveSessionSuggestions?: boolean;
    onResolveSessionSuggestion?: (
      suggestion: SessionSuggestion,
      resolution: SessionSuggestionResolution,
    ) => void;
    detailsEnabled?: boolean;
  };

type ChatViewInput = {
  props: ChatProps;
  frame: ChatViewFrame;
  presented: boolean;
  application?: ApplicationContext;
};

function ChatTranscript(input: ChatViewInput) {
  return (
    <Show
      when={input.application}
      keyed
      fallback={<ChatThread props={input.frame.threadProps} transcript={input.props.transcript} />}
    >
      {(application) => (
        <ApplicationProvider value={application}>
          <ChatThread props={input.frame.threadProps} transcript={input.props.transcript} />
        </ApplicationProvider>
      )}
    </Show>
  );
}

function ChatFooterContent(input: ChatViewInput) {
  return (
    <Show when={input.application} keyed fallback={<ChatFooterContents {...input} />}>
      {(application) => (
        <ApplicationProvider value={application}>
          <ChatFooterContents {...input} />
        </ApplicationProvider>
      )}
    </Show>
  );
}

function ChatFooterContents(input: ChatViewInput) {
  const pendingInputs = () => input.frame.pendingInputs;
  const pendingButton = (page: "earlier" | "latest") => (
    <button
      class="btn btn--sm"
      type="button"
      disabled={pendingInputs()?.loading}
      onClick={() => {
        if (input.props.historyState) {
          void loadChatPendingInputs(
            input.props.historyState,
            page === "earlier" ? pendingInputs()?.page.nextBefore : undefined,
          );
        }
      }}
    >
      {t(`chat.pendingInputs.${page}`)}
    </button>
  );
  return (
    <>
      <Show
        when={
          pendingInputs() &&
          (pendingInputs()?.error ||
            pendingInputs()?.page.nextBefore !== undefined ||
            pendingInputs()?.before !== undefined)
        }
      >
        <div class="chat-pending-inputs" role="status">
          <Show when={pendingInputs()?.error}>
            <span>{pendingInputs()?.error}</span>
          </Show>
          <Show when={pendingInputs()?.page.nextBefore !== undefined}>
            {pendingButton("earlier")}
          </Show>
          <Show when={pendingInputs()?.before !== undefined}>{pendingButton("latest")}</Show>
        </div>
      </Show>
      <Show when={input.props.inlineApproval && input.props.onApprovalDecision}>
        <div class="chat-inline-approval">
          <ExecApprovalCard
            props={{
              approval: input.props.inlineApproval!,
              sourceSession: input.frame.approvalSourceSession,
              busy: input.props.approvalBusy === true,
              canGrant: input.props.approvalCanGrant,
              error: input.props.approvalErrors?.get(input.props.inlineApproval!.id) ?? null,
              variant: "inline",
              onDecision: input.props.onApprovalDecision!,
            }}
          />
        </div>
      </Show>
      <Show when={!input.props.detailsEnabled}>
        <LitContent
          value={renderChatPullRequests({
            pullRequests: input.props.pullRequests ?? [],
            gateway: input.props.pullRequestsGateway,
            sessionId: input.props.pullRequestsSessionId,
            sessionKey: scopedSessionArtifactKey(
              input.props.sessionKey,
              input.props.currentAgentId ?? undefined,
            ),
            presented: input.props.presented ?? true,
            branch: input.props.pullRequestsBranch,
            branchDismissed: input.props.pullRequestsBranchDismissed,
            status: input.props.pullRequestsStatus ?? "ready",
            onDismiss: (pullRequest) => input.props.onDismissPullRequest?.(pullRequest),
            onDismissBranch: input.props.onDismissPullRequestsBranch,
            onOpenSessionDiff: input.props.onOpenSessionDiff,
            publication: input.props.githubPublication,
          })}
        />
      </Show>
      <LitContent
        value={renderChatSessionSuggestions({
          suggestions: input.props.sessionSuggestions ?? [],
          role: input.props.sessionSuggestionRole,
          busyIds: input.props.sessionSuggestionBusyIds ?? new Set(),
          archived: input.props.sessionSuggestionsArchived === true,
          canResolve: input.props.canResolveSessionSuggestions === true,
          onResolve: (suggestion, resolution) =>
            input.props.onResolveSessionSuggestion?.(suggestion, resolution),
        })}
      />
      <Show when={input.props.swarm}>
        <LitContent value={renderChatSwarmProgress(input.props.swarm!)} />
      </Show>
      <Show when={input.application}>
        <PluginContributions
          kind="composer"
          sessionKey={input.props.sessionKey}
          agentId={input.props.currentAgentId}
          presented={input.presented}
        />
      </Show>
    </>
  );
}

function ChatComposerNotices(input: { props: ChatProps }) {
  return <ChatComposerNoticesView {...input.props} />;
}

function ChatComposerView(input: ChatViewInput) {
  // Until the composer lane lands, its one legacy range keeps textarea identity.
  return (
    <LitContent
      value={renderChatComposer({
        ...input.props,
        progressCard: input.props.detailsEnabled ? null : input.props.progressCard,
        progressCardInitialLoading: input.props.detailsEnabled
          ? false
          : input.props.progressCardInitialLoading,
        asyncQuestions: input.frame.asyncQuestions,
        displayQueue: input.frame.displayQueue,
        footerContent: solidContent(ChatFooterContent, {
          props: input.props,
          frame: input.frame,
          presented: input.presented,
          application: input.application,
        }),
        notices: solidContent(ChatComposerNotices, { props: input.props }),
        onRequestUpdate: input.frame.requestUpdate,
        onToggleRealtimeTalk: input.props.suggestionComposer
          ? undefined
          : input.props.onToggleRealtimeTalk,
        onOpenImage: input.frame.openImmediateImage,
      })}
    />
  );
}

function ChatComposerCompanion(input: ChatViewInput) {
  return (
    <div class="chat-footer__context">
      <ChatFooterContent {...input} />
      <div class="agent-chat__composer-notices">
        <ChatComposerNotices props={input.props} />
      </div>
      <LitContent
        value={renderComposerQuestionDock(
          resolveComposerQuestionPanel(
            { ...input.props, asyncQuestions: input.frame.asyncQuestions },
            getChatComposerState(input.props.paneId),
            input.frame.requestUpdate,
          ),
        )}
      />
      <LitContent
        value={renderChatComposerQueue(
          { ...input.props, displayQueue: input.frame.displayQueue },
          Boolean(input.props.canAbort && input.props.onAbort) &&
            !hasTerminalRunStatus(input.props.runStatus),
        )}
      />
      <Show when={!input.props.suggestionComposer}>
        <LitContent
          value={renderChatSelectionAnnotations({ ...input.props, disabled: !input.props.canSend })}
        />
      </Show>
      <LitContent value={input.props.composerRecovery ?? emptyLegacyContent} />
    </div>
  );
}

function ChatSurface<S extends "transcript" | "composer">(input: {
  surface: S;
  surfaceProps: ControlUiSurfaceProps[S];
  viewProps: ChatViewInput;
  view: Component<ChatViewInput>;
  companion?: Component<ChatViewInput>;
}) {
  const app = useOptionalApplication();
  const runtime = projectSource(app?.plugins, {
    read: (source) => source,
    subscribe: (source, publish) => source?.subscribe(publish) ?? (() => {}),
    equality: "revision",
  });
  const selected = createMemo(() => runtime.read()?.selectedReplacement(input.surface));
  return (
    <Show when={selected()} fallback={<input.view {...input.viewProps} />}>
      <PluginView
        surface={input.surface}
        props={input.surfaceProps}
        presented={input.viewProps.presented}
        data-plugin-composer={input.surface === "composer" ? "" : undefined}
        defaultView={solidContent(input.view, input.viewProps)}
        replacementCompanion={
          input.companion ? solidContent(input.companion, input.viewProps) : undefined
        }
      />
    </Show>
  );
}

export function ChatView(input: { props: ChatProps; application?: ApplicationContext }) {
  return (
    <Show when={input.application} keyed fallback={<ChatContent props={input.props} />}>
      {(application) => (
        <ApplicationProvider value={application}>
          <ChatContent props={input.props} />
        </ApplicationProvider>
      )}
    </Show>
  );
}

function ChatContent(input: { props: ChatProps }) {
  const application = useOptionalApplication();
  const frame = createMemo(() => createChatViewFrame(input.props));
  const [presentationRevision, setPresentationRevision] = createSignal(0, { ownedWrite: true });
  createEffect(
    () => input.props.presented,
    (binding) => {
      if (typeof binding !== "object") {
        return undefined;
      }
      const notify = () => setPresentationRevision((value) => value + 1);
      binding.owner.addEventListener(PRESENTATION_CHANGED_EVENT, notify);
      return () => binding.owner.removeEventListener(PRESENTATION_CHANGED_EVENT, notify);
    },
  );
  const presented = () => {
    presentationRevision();
    const binding = input.props.presented;
    return typeof binding === "object" ? binding.isPresented() : (binding ?? true);
  };
  const viewProps = () => ({
    props: input.props,
    frame: frame(),
    presented: presented(),
    application,
  });
  const historyMessage = () => {
    const state = frame().historyLoadState;
    return state?.phase === "failed" ? state.message : "";
  };
  const historyFailure = (inline: boolean) => (
    <div
      class={["chat-history-error", { "chat-history-error--inline": inline }]}
      role={inline ? "status" : "alert"}
    >
      <span>{historyMessage()}</span>
      <button
        class="btn btn--sm"
        type="button"
        onClick={() => {
          const state = input.props.historyState;
          if (state && getChatHistoryLoadState(state).phase === "failed") {
            input.props.onRefresh();
            state.requestUpdate?.();
          }
        }}
      >
        {t("common.retry")}
      </button>
    </div>
  );
  const taskSuggestionTray = createMemo(() => renderChatTaskSuggestionTray(input.props));
  return (
    <section
      class={["chat", { "chat--bubbles": input.props.chatBubbleMode }]}
      style={
        input.props.chatMessageMaxWidth
          ? {
              "--chat-thread-max-width": input.props.chatMessageMaxWidth,
              "--chat-message-max-width": "100%",
            }
          : {}
      }
      onDrop={(event) => frame().attachmentDropHandlers.onDrop(event)}
      onDragEnter={(event) => frame().attachmentDropHandlers.onDragenter(event)}
      onDragLeave={(event) => frame().attachmentDropHandlers.onDragleave(event)}
      onDragOver={(event) => frame().attachmentDropHandlers.onDragover(event)}
      onClick={(event) => openInlineChatImage(event, frame().openImmediateImage)}
      onKeyDown={(event) => {
        if (isImageLightboxEvent(event)) {
          return;
        }
        if (
          (event.key === "Enter" || event.key === " ") &&
          openInlineChatImage(event, frame().openImmediateImage)
        ) {
          return;
        }
        if (
          event.key === "Escape" &&
          input.props.replyTarget &&
          !event.defaultPrevented &&
          !event.isComposing &&
          event.keyCode !== 229 &&
          !getChatComposerState(input.props.paneId).composerComposing
        ) {
          event.preventDefault();
          input.props.onClearReply?.();
          return;
        }
        if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.transcriptSearch, event)) {
          event.preventDefault();
          toggleTranscriptSearch(input.props.paneId, frame().requestUpdate, event);
        }
      }}
    >
      <Show when={!input.props.suggestionComposer}>
        <ChatCommentController
          paneId={input.props.paneId}
          props={input.props}
          disabled={!input.props.canSend}
          sessionKey={input.props.sessionKey}
          presented={presented()}
        />
      </Show>
      <div class="chat-workbench">
        <div class="chat-workbench__main">
          <div class="chat-split-container">
            <div class="chat-main">
              <div class="chat-main__conversation-column">
                <Show when={!input.props.detailsEnabled}>
                  {renderChatTopbarNotices(input.props)}
                </Show>
                <Show when={application}>
                  <PluginContributions
                    kind="header"
                    sessionKey={input.props.sessionKey}
                    agentId={input.props.currentAgentId}
                    presented={presented()}
                  />
                </Show>
                <LitContent
                  value={renderTranscriptSearch(input.props.paneId, frame().requestUpdate)}
                />
                <div class="chat-main__conversation-frame">
                  <div
                    class="chat-main__conversation"
                    onWheel={(event) =>
                      forwardChatWheelToTranscript(event, input.props.transcript.scrollElement)
                    }
                  >
                    <Show when={frame().historyFailed && !frame().transcriptEmpty}>
                      {historyFailure(true)}
                    </Show>
                    <Show
                      when={!(frame().historyFailed && frame().transcriptEmpty)}
                      fallback={historyFailure(false)}
                    >
                      <ChatSurface
                        surface="transcript"
                        surfaceProps={{
                          sessionKey: input.props.sessionKey,
                          agentId: input.props.currentAgentId,
                          messages: input.props.messages,
                          stream: input.props.stream,
                          loading: input.props.loading,
                        }}
                        viewProps={viewProps()}
                        view={ChatTranscript}
                      />
                    </Show>
                    {/* Keep the affordance mounted so showing it never changes transcript layout. */}
                    <Show when={input.props.onScrollToBottom}>
                      <div class="chat-scroll-to-bottom-wrap">
                        <button
                          class="chat-scroll-to-bottom"
                          data-visible={Boolean(input.props.showNewMessages)}
                          type="button"
                          inert={!input.props.showNewMessages}
                          aria-hidden={!input.props.showNewMessages ? "true" : "false"}
                          onClick={() => input.props.onScrollToBottom?.({ smooth: true })}
                          aria-label={t("chat.actions.scrollToLatest")}
                        >
                          <Icon name="arrowDown" />
                        </button>
                      </div>
                    </Show>
                    <Show
                      when={
                        input.props.detailsEnabled || taskSuggestionTray() !== emptyLegacyContent
                      }
                    >
                      <div
                        class={[
                          "chat-gutter-stack",
                          { "chat-gutter-stack--details": input.props.detailsEnabled },
                        ]}
                      >
                        <div class="chat-gutter-header" hidden={!input.props.detailsEnabled}>
                          <Show when={input.props.detailsEnabled}>
                            {renderChatTopbarNotices(input.props)}
                          </Show>
                        </div>
                        <LitContent value={taskSuggestionTray()} />
                      </div>
                    </Show>
                    <div class="chat-footer">
                      <ChatSurface
                        surface="composer"
                        surfaceProps={{
                          sessionKey: input.props.sessionKey,
                          agentId: input.props.currentAgentId,
                          draft: input.props.draft,
                          canSend: input.props.canSend && !input.props.submitDisabledReason,
                          sending: input.props.sending,
                          disabledReason:
                            input.props.submitDisabledReason ?? input.props.disabledReason,
                          setDraft: input.props.onDraftChange,
                          send: async () => input.props.onSend(),
                          abort: input.props.onAbort,
                        }}
                        viewProps={viewProps()}
                        view={ChatComposerView}
                        companion={ChatComposerCompanion}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Remaining Lit hosts share the native view's retained root. */
export function renderChat(props: ChatProps, application?: ApplicationContext) {
  return solidContent(ChatView, { props, application });
}
