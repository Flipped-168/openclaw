/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
} from "./chat-pane.test-support.ts";
import { ChatPaneView, type ChatPaneElement } from "./chat-pane.tsx";

it("exposes the current navigation face through the real pane host without a gateway read", async () => {
  // Keep this boundary test on bridge properties and the real navigation method.
  // Full pane startup/retirement is covered by the mounted lifecycle suites.
  const connected = vi
    .spyOn(ChatPaneRuntime.prototype, "connectedCallback")
    .mockImplementation(() => {});
  const disconnected = vi
    .spyOn(ChatPaneRuntime.prototype, "disconnectedCallback")
    .mockImplementation(() => {});
  onTestFinished(() => {
    connected.mockRestore();
    disconnected.mockRestore();
  });
  const request = vi.fn(async () => ({}));
  const context = createInitializationContext(createGatewayBrowserClientFixture({ request }));
  context.gateway.snapshot.phase = "stopped";
  const [face, setFace] = createSignal<"chat" | "dashboard">("chat");
  const view = mountSolid(() => (
    <ApplicationProvider value={context}>
      <ChatPaneView paneId="bridge-navigation" sessionKey="agent:main:bridge" routeFace={face()} />
    </ApplicationProvider>
  ));
  const pane = view.container.querySelector<ChatPaneElement>("openclaw-chat-pane");
  expect(pane).not.toBeNull();
  await waitForSolid(() => expect(pane?.captureNavigationFace()).toBe("chat"));

  setFace("dashboard");
  await waitForSolid(() => expect(pane?.captureNavigationFace()).toBe("dashboard"));
  setFace("chat");
  await waitForSolid(() => expect(pane?.captureNavigationFace()).toBe("chat"));
  expect(request).not.toHaveBeenCalled();
  view.unmount();
});
