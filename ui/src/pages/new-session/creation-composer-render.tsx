import { createMemo, Show } from "solid-js";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { solidContent } from "../../lit/solid-content.tsx";
import { resolveChatAttachmentLimits } from "../chat/components/chat-attachment-admission.ts";
import { getChatComposerState } from "../chat/components/chat-composer-state.ts";
import type { ChatComposerProps } from "../chat/components/chat-composer-types.ts";
import { ChatComposer, resetChatComposerState } from "../chat/components/chat-composer.tsx";
import type { CreationComposer } from "./creation-composer.ts";

function creationComposerProps(
  composer: CreationComposer,
  onOpenImage: (item: ImageLightboxItem) => void,
): ChatComposerProps {
  const { context, attachmentDraft } = composer;
  const reads = attachmentDraft.reads;
  const signal = reads.readSignal;
  const paneId = "creation-" + composer.id;
  composer.releasePresentation = () => resetChatComposerState(paneId);
  composer.flushInput = () => {
    const textarea = getChatComposerState(paneId).composerTextarea;
    if (textarea?.isConnected && textarea.value !== composer.message) {
      composer.setMessage(textarea.value);
    }
  };
  return {
    paneId,
    sessionKey: paneId,
    currentAgentId: composer.agentId,
    connected: false,
    sessionAdmitted: false,
    canCompose: true,
    canSend: true,
    disabledReason: null,
    sending: false,
    messages: [],
    stream: null,
    queue: composer.inputs,
    draft: composer.message,
    getDraft: () => composer.message,
    mentions: composer.mentions,
    getMentions: () => composer.mentions,
    mentionsUnsupported: composer.incognito,
    modelCatalog: [],
    modelSwitching: false,
    sessions: null,
    assistantName: "",
    sendShortcut: context.theme?.settings.chatSendShortcut,
    uploadConfig: context.config,
    attachmentLimits: resolveChatAttachmentLimits(context.gateway.snapshot.hello?.policy),
    attachments: attachmentDraft.attachments,
    getAttachments: () => attachmentDraft.attachments,
    attachmentReads: reads,
    pendingAttachmentReads: reads.pendingReads,
    getPendingAttachmentReads: () => reads.pendingReads,
    readSignal: signal,
    onPendingReadsChange: (delta) => reads.updatePending(signal, delta),
    onAttachmentsChange: (attachments) => {
      if (composer.canDisplay()) {
        attachmentDraft.replace(attachments);
      }
    },
    onDraftChange: (message: string, mentions?: readonly HumanMention[]) =>
      composer.setMessage(message, mentions),
    onSend: () => {
      composer.enqueue();
    },
    onQueueRemove: (id) => composer.remove(id),
    onOpenImage,
    onRequestUpdate: composer.notify,
  };
}

/** This view has no Gateway client: it can compose and stage, never execute session controls. */
export function CreationComposerView(props: {
  composer: CreationComposer | undefined;
  onOpenImage: (item: ImageLightboxItem) => void;
  renderRevision?: object;
}) {
  const active = createMemo(() => {
    void props.renderRevision;
    return props.composer?.canDisplay() ? props.composer : undefined;
  });
  return (
    <Show when={active()} keyed>
      {(composer) => {
        const input = createMemo(() => {
          void props.renderRevision;
          return {
            fields: creationComposerProps(composer, props.onOpenImage),
            error: composer.error,
          };
        });
        return (
          <section class="creation-composer" aria-label={t("newSession.followUps")}>
            <Show when={input().error}>
              {(error) => (
                <div class="callout danger" role="alert">
                  {error()}
                </div>
              )}
            </Show>
            <ChatComposer {...input().fields} renderRevision={props.renderRevision} />
          </section>
        );
      }}
    </Show>
  );
}

export function renderCreationComposer(
  composer: CreationComposer | undefined,
  onOpenImage: (item: ImageLightboxItem) => void,
) {
  return solidContent(CreationComposerView, { composer, onOpenImage, renderRevision: {} });
}
