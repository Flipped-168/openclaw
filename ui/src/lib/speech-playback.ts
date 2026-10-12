import type { TtsSpeakResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { base64ToBytes } from "./bytes-base64.ts";

/** Browser playback only; the Gateway owns provider selection and synthesis. */
export class GatewaySpeechPlayback {
  private generation = 0;
  private finish: (() => void) | undefined;

  stop(): void {
    this.generation += 1;
    this.finish?.();
  }

  async speak(
    client: GatewayBrowserClient,
    text: string,
    method: "tts.speak" | "talk.speak" = "tts.speak",
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    this.stop();
    const generation = this.generation;
    const result = await client.request<TtsSpeakResult>(method, { text });
    if (generation !== this.generation || !isCurrent()) {
      return;
    }
    const url = URL.createObjectURL(
      new Blob([base64ToBytes(result.audioBase64)], { type: result.mimeType }),
    );
    const audio = new Audio(url);
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (this.finish !== cancel) {
          return;
        }
        this.finish = undefined;
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        URL.revokeObjectURL(url);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const cancel = () => finish();
      this.finish = cancel;
      audio.onended = cancel;
      audio.onerror = () => finish(new Error("The browser could not play the generated speech."));
      void audio
        .play()
        .catch((error: unknown) =>
          finish(error instanceof Error ? error : new Error(String(error))),
        );
    });
  }
}
