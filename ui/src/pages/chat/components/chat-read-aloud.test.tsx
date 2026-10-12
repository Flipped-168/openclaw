/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  createContext,
  createRuntimeConfigStub,
} from "../../skill-workshop/skill-workshop-page.test-support.ts";
import {
  MessageActions,
  prepareChatMessageRender,
  resolveMessageActionDetails,
} from "./chat-message-markdown-view.tsx";

const audio: HTMLAudioElement[] = [];
const play = vi.fn(async () => undefined);
const pause = vi.fn();
const revoke = vi.fn();
const createUrl = vi.fn<(blob: Blob | MediaSource) => string>(() => "blob:synthetic-speech");

beforeEach(() => {
  audio.length = 0;
  play.mockReset().mockResolvedValue(undefined);
  pause.mockClear();
  revoke.mockClear();
  createUrl.mockClear();
  vi.stubGlobal("Audio", function (src: string) {
    const element = document.createElement("audio");
    element.src = src;
    element.play = play;
    element.pause = pause;
    element.load = () => undefined;
    audio.push(element);
    return element;
  });
  vi.spyOn(URL, "createObjectURL").mockImplementation(createUrl);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(request: ReturnType<typeof vi.fn>, configured = true) {
  const runtimeConfig = createRuntimeConfigStub();
  Object.assign(runtimeConfig.state, {
    configSnapshot: { runtimeConfig: configured ? { tts: { provider: "openai" } } : {} },
  });
  const context = createContext(request, { methods: ["tts.speak"], runtimeConfig });
  const provider = createSolidApplicationContextProvider(context);
  const details = resolveMessageActionDetails(
    prepareChatMessageRender({ role: "assistant", content: "Local voice is working." }),
    { messageId: "reply-1", senderLabel: "OpenClaw" },
  );
  return mountSolid(() => <MessageActions details={details} options={{}} />, {
    wrapper: provider.wrapper,
  });
}

it("unlocks and reuses the same audio element before awaiting Gateway speech", async () => {
  const pending = createDeferred();
  const request = vi.fn(() => pending.promise);
  let userActivation = true;
  const permitted = new WeakSet<HTMLAudioElement>();
  play.mockImplementation(function (this: HTMLAudioElement) {
    if (userActivation) {
      permitted.add(this);
    }
    return permitted.has(this)
      ? Promise.resolve()
      : Promise.reject(new DOMException("User activation required", "NotAllowedError"));
  });
  const view = mount(request);
  const button = view.getByRole<HTMLButtonElement>("button", { name: "Read aloud" });
  button.click();
  userActivation = false;
  expect(play).toHaveBeenCalledOnce();
  expect(audio).toHaveLength(1);
  expect(audio[0]?.src).toMatch(/^data:audio\/wav/);
  pending.resolve({ audioBase64: "UklGRg==", mimeType: "audio/wav", provider: "openai" });
  await waitForSolid(() => expect(play).toHaveBeenCalledTimes(2));
  expect(request).toHaveBeenCalledWith("tts.speak", { text: "Local voice is working." });
  expect(createUrl.mock.calls[0]?.[0]).toMatchObject({ type: "audio/wav", size: 4 });
  expect(audio[0]?.src).toBe("blob:synthetic-speech");
  view.getByRole<HTMLButtonElement>("button", { name: "Stop reading" }).click();
  flush();
  expect(pause).toHaveBeenCalledTimes(2);
  expect(revoke).toHaveBeenCalledWith("blob:synthetic-speech");
  expect(view.getByRole("button", { name: "Read aloud" })).toBe(button);
});

it("leaves unconfigured speech controls absent", () => {
  const request = vi.fn();
  const view = mount(request, false);
  expect(view.queryByRole("button", { name: "Read aloud" })).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

it("does not play a synthesis result after the message is unmounted", async () => {
  const pending = createDeferred();
  const view = mount(vi.fn(() => pending.promise));
  view.getByRole<HTMLButtonElement>("button", { name: "Read aloud" }).click();
  view.unmount();
  pending.resolve({ audioBase64: "UklGRg==", mimeType: "audio/wav", provider: "openai" });
  await pending.promise;
  await Promise.resolve();
  expect(createUrl).not.toHaveBeenCalled();
  expect(play).toHaveBeenCalledOnce();
});

it("shows a Gateway synthesis failure instead of starting another speech provider", async () => {
  const request = vi.fn(async () => {
    throw new Error("Local speech endpoint unavailable");
  });
  const view = mount(request);
  view.getByRole<HTMLButtonElement>("button", { name: "Read aloud" }).click();
  await waitForSolid(() =>
    expect(view.getByRole("status").textContent).toContain("Local speech endpoint unavailable"),
  );
  expect(request).toHaveBeenCalledOnce();
  expect(play).toHaveBeenCalledOnce();
});
