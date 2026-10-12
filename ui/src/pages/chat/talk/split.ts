import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../../api/gateway.ts";
import { t } from "../../../i18n/index.ts";
import { extractText } from "../../../lib/chat/message-extract.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { GatewaySpeechPlayback } from "../../../lib/speech-playback.ts";
import { isTerminalFailureChatSendAck, type ChatSendAck } from "../chat-send-ack.ts";
import { ComposerDictationSession } from "../composer-dictation-session.ts";
import type { RealtimeTalkCallbacks, RealtimeTalkTransport } from "./shared.ts";

export type SplitTalkOptions = {
  silenceTimeoutMs: number;
  speechMethod: "talk.speak" | "tts.speak";
  sendMessage: (message: string, runId: string) => Promise<ChatSendAck>;
};

/** Split Talk uses the same capture, chat, and speech owners as the composer. */
export class SplitTalkTransport implements RealtimeTalkTransport {
  private capture: ComposerDictationSession | null = null;
  private readonly playback = new GatewaySpeechPlayback();
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private runId: string | undefined;
  private settleChat: ((result: string | Error) => void) | undefined;

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly sessionKey: string,
    private readonly callbacks: RealtimeTalkCallbacks,
    private readonly options: SplitTalkOptions,
    private readonly inputDeviceId?: string,
  ) {}

  async start(): Promise<"ready" | "cancelled"> {
    this.unsubscribe = this.client.addEventListener((event) => this.handleChat(event));
    this.callbacks.onVideoCapability?.(false);
    await this.listen();
    return this.closed ? "cancelled" : "ready";
  }

  stop(): void {
    this.closed = true;
    const capture = this.capture;
    this.capture = null;
    capture?.cancelPendingFinal();
    void capture?.cancel().catch(() => undefined);
    this.playback.stop();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.settleChat?.("");
    this.settleChat = undefined;
    if (this.runId) {
      void this.abortRun(this.runId);
      this.runId = undefined;
    }
    this.callbacks.onInputLevel?.(0);
  }

  private async listen(): Promise<void> {
    if (this.closed) {
      return;
    }
    const capture = new ComposerDictationSession(
      this.client,
      {
        onReady: () => this.callbacks.onStatus?.("listening"),
        onError: (message) => this.fail(new Error(message)),
        onLevel: (level) => this.callbacks.onInputLevel?.(level),
        onTranscriptChange: () => undefined,
        onSilence: () => void this.completeTurn(capture),
      },
      { inputDeviceId: this.inputDeviceId, silenceTimeoutMs: this.options.silenceTimeoutMs },
    );
    this.capture = capture;
    await capture.start();
  }

  private async completeTurn(capture: ComposerDictationSession): Promise<void> {
    if (this.closed || this.capture !== capture) {
      return;
    }
    this.callbacks.onStatus?.("thinking");
    try {
      const text = await capture.finish(true);
      if (this.closed || this.capture !== capture) {
        return;
      }
      this.capture = null;
      if (text) {
        const answer = await this.send(text);
        if (this.closed) {
          return;
        }
        if (answer) {
          await this.playback.speak(
            this.client,
            answer,
            this.options.speechMethod,
            () => !this.closed,
          );
        }
      }
      await this.listen();
    } catch (error) {
      this.fail(error);
    }
  }

  private async send(message: string): Promise<string> {
    const runId = crypto.randomUUID();
    this.runId = runId;
    const answer = new Promise<string>((resolve, reject) => {
      this.settleChat = (result) => (result instanceof Error ? reject(result) : resolve(result));
    });
    // A terminal event can precede the admission ACK; subscribe before sending.
    void answer.catch(() => undefined);
    const ack = await this.options.sendMessage(message, runId);
    if (this.closed) {
      await this.abortRun(ack.runId);
      return "";
    }
    if (isTerminalFailureChatSendAck(ack)) {
      throw new Error(t("chat.voice.replyFailed"));
    }
    if (this.runId === runId) {
      this.runId = ack.runId;
      if (ack.status === "ok") {
        this.settleChat?.("");
        this.settleChat = undefined;
        this.runId = undefined;
      }
    }
    return await answer;
  }

  private handleChat(event: GatewayEventFrame): void {
    if (event.event !== "chat" || !this.runId) {
      return;
    }
    const payload = asOptionalObjectRecord(event.payload);
    if (payload?.runId !== this.runId) {
      return;
    }
    if (payload.state === "final" || payload.state === "error" || payload.state === "aborted") {
      const result =
        payload.state === "final"
          ? (extractText(payload.message)?.trim() ?? "")
          : new Error(
              typeof payload.errorMessage === "string"
                ? payload.errorMessage
                : t("chat.voice.replyFailed"),
            );
      this.runId = undefined;
      this.settleChat?.(result);
      this.settleChat = undefined;
    }
  }

  private async abortRun(runId: string): Promise<void> {
    await this.client
      .request("chat.abort", { sessionKey: this.sessionKey, runId })
      .catch(() => undefined);
  }

  private fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.stop();
    this.callbacks.onStatus?.("error", formatUiError(error));
  }
}
