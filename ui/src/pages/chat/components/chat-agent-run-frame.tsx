import { createMemo, For, Match, Show, Switch } from "solid-js";
import type { MessageGroup as MessageGroupData } from "../../../lib/chat/chat-types.ts";
import { extractChatSourcePreviews } from "../../../lib/chat/source-previews.ts";
import { LitContent } from "../../../lit/solid-bridge.ts";
import {
  agentRunFrameActiveStatusParts,
  chatItemGroups,
  type AgentRunFrameRenderItem,
} from "../chat-agent-run-grouping.ts";
import type { TurnRecap } from "../chat-progress.ts";
import { rawMessageTimestamp } from "../chat-thread-items.ts";
import {
  ActivityGroup,
  MessageGroup,
  MessageGroupContent,
  type NativeMessageGroupOptions,
} from "./chat-message-group-view.tsx";
import {
  StreamGroup,
  StreamPartView,
  WorkGroupSummary,
  type StreamGroupOptions,
  type StreamGroupPart,
} from "./chat-message-stream-view.tsx";
import { resolveGroupReplyLine } from "./chat-reply-attribution.ts";
import { renderChatSourcePreviews } from "./chat-source-previews.ts";
import { renderWorkGroupBrowserTabPreviews } from "./chat-tool-cards.ts";

type AgentRunFrameOptions = {
  basePath?: string;
  sessionPublicOrigin?: string;
  streamOptions: StreamGroupOptions;
  renderGroupOptions: (group: MessageGroupData) => NativeMessageGroupOptions;
  isWorkExpanded: (key: string) => boolean;
  onToggleWork: (key: string, expanded: boolean) => void;
  turnRecap?: TurnRecap;
};
type FrameProps = { frame: AgentRunFrameRenderItem; options: AgentRunFrameOptions };
type BodyPart =
  | Exclude<AgentRunFrameRenderItem["parts"][number], { kind: "stream-run" }>
  | StreamGroupPart;

function prepareFrame(frame: AgentRunFrameRenderItem, opts: AgentRunFrameOptions) {
  const groups = chatItemGroups(frame);
  const firstAssistant = groups.find((group) => group.role === "assistant");
  const actionOwner = frame.outcome.kind === "completed" ? frame.outcome.actionOwner : null;
  const representative = firstAssistant ?? groups[0];
  const streamStarts = frame.parts.flatMap((part) =>
    part.kind === "stream-run" ? part.parts.map((streamPart) => streamPart.startedAt) : [],
  );
  const streamRun = frame.parts.find((part) => part.kind === "stream-run");
  const shell: MessageGroupData = {
    key: frame.key,
    kind: "group",
    role: "assistant",
    senderLabel: firstAssistant?.senderLabel,
    replyToSender: firstAssistant?.replyToSender ?? streamRun?.replyToSender,
    replyToMessage: firstAssistant?.replyToMessage ?? streamRun?.replyToMessage,
    replyShared: firstAssistant?.replyShared,
    replyTurnSource: firstAssistant?.replyTurnSource,
    replyCurrentSource: firstAssistant?.replyCurrentSource,
    messages: representative?.messages ?? [],
    visibleContent: representative?.visibleContent ?? "none",
    timestamp:
      (actionOwner ? rawMessageTimestamp(actionOwner.message) : null) ??
      Math.min(...groups.map((group) => group.timestamp), ...streamStarts, Date.now()),
    isStreaming: frame.outcome.kind === "active",
    runId: frame.runId,
  };
  const frameReplyLine = resolveGroupReplyLine(
    (actionOwner && groups.find((group) => group.messages.includes(actionOwner))) || shell,
    opts.renderGroupOptions(shell).resolveReplyPreview,
    groups.flatMap((group) => group.messages),
  );
  // A preceding segment becoming history must not reparent the live answer.
  const bodyParts = frame.parts.flatMap<BodyPart>((part) =>
    part.kind === "stream-run" ? part.parts : [part],
  );
  const firstBubbleKey =
    bodyParts
      .flatMap((part) =>
        part.kind === "stream"
          ? part.text.trim()
            ? [part.key]
            : []
          : part.kind === "group" && part.role !== "tool"
            ? part.messages
                .filter((message) => message.hasVisibleContent)
                .map((message) => message.key)
            : [],
      )
      .at(0) ?? null;
  const workPreviews = renderWorkGroupBrowserTabPreviews(
    frame.parts.flatMap((part) =>
      !opts.streamOptions.bubbleMode && part.kind === "work-group" && !opts.isWorkExpanded(part.key)
        ? [part]
        : [],
    ),
    opts.renderGroupOptions(shell),
  );
  const sourcePreviews = actionOwner
    ? renderChatSourcePreviews(
        extractChatSourcePreviews({
          groups,
          answer: actionOwner.message,
          runId: frame.runId,
          basePath: opts.basePath,
          sessionPublicOrigin: opts.sessionPublicOrigin,
        }),
        opts.streamOptions.fetchLinkFavicon,
      )
    : undefined;
  return {
    shell,
    actionOwner,
    frameReplyLine,
    bodyParts,
    firstBubbleKey,
    workPreviews,
    sourcePreviews,
  };
}

export function AgentRunFrame(props: FrameProps) {
  const statusParts = createMemo(() => agentRunFrameActiveStatusParts(props.frame));
  return (
    <Show when={statusParts()} fallback={<RunFrame frame={props.frame} options={props.options} />}>
      {(parts) => <StreamGroup parts={parts()} options={props.options.streamOptions} />}
    </Show>
  );
}

function RunFrame(props: FrameProps) {
  const state = createMemo(() => prepareFrame(props.frame, props.options));
  const groupOptions = (group: MessageGroupData) => ({
    ...props.options.renderGroupOptions(group),
    firstBubbleKey: state().firstBubbleKey,
  });
  const frameContent = [
    <For each={state().bodyParts} keyed={(part) => part.kind + ":" + part.key}>
      {(part) => {
        const streamPart = () => {
          const value = part();
          return value.kind === "stream" ||
            value.kind === "reading-indicator" ||
            value.kind === "question"
            ? value
            : undefined;
        };
        const workPart = () => {
          const value = part();
          return value.kind === "work-group" ? value : undefined;
        };
        const activityPart = () => {
          const value = part();
          return value.kind === "activity-run" ? value : undefined;
        };
        const messageGroup = () => {
          const value = part();
          return value.kind === "group" ? value : undefined;
        };
        return (
          <Switch>
            <Match when={streamPart()}>
              {(stream) => (
                <StreamPartView
                  part={stream()}
                  options={{
                    ...props.options.streamOptions,
                    firstBubbleKey: state().firstBubbleKey,
                  }}
                  presentation="standalone"
                />
              )}
            </Match>
            <Match when={workPart()}>
              {(work) => (
                <>
                  <WorkGroupSummary
                    item={work()}
                    options={{
                      expanded: props.options.isWorkExpanded(work().key),
                      bubbleMode: props.options.streamOptions.bubbleMode,
                      onToggle: () =>
                        props.options.onToggleWork(
                          work().key,
                          props.options.isWorkExpanded(work().key),
                        ),
                      presentation: "continuation",
                      browserTabPreviews: state().workPreviews.get(work().key),
                    }}
                  />
                  <Show when={props.options.isWorkExpanded(work().key)}>
                    <For each={work().groups} keyed={(group) => group.key}>
                      {(group) => (
                        <MessageGroupContent group={group()} options={groupOptions(group())} />
                      )}
                    </For>
                  </Show>
                </>
              )}
            </Match>
            <Match when={activityPart()}>
              {(activity) => {
                const groups = () => activity().groups;
                return (
                  <Show when={groups()[0]}>
                    {(first) => (
                      <ActivityGroup
                        groups={groups()}
                        options={props.options.renderGroupOptions(first())}
                        presentation="continuation"
                      />
                    )}
                  </Show>
                );
              }}
            </Match>
            <Match when={messageGroup()}>
              {(group) => (
                <>
                  <MessageGroupContent group={group()} options={groupOptions(group())} />
                  <LitContent render={() => state().workPreviews.get(group().key)} />
                </>
              )}
            </Match>
          </Switch>
        );
      }}
    </For>,
    <LitContent render={() => state().sourcePreviews} />,
  ];
  return (
    <MessageGroup
      group={state().shell}
      options={{
        ...props.options.renderGroupOptions(state().shell),
        frameContent,
        frameReplyLine: state().frameReplyLine,
        frameActionOwner: state().actionOwner,
        turnRecap: props.options.turnRecap,
      }}
    />
  );
}
