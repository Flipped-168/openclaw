/* @vitest-environment jsdom */
import { expect, onTestFinished, vi } from "vitest";
import { ChatPaneRuntime } from "../pages/chat/chat-pane-render.ts";
import { createTestChatPane } from "../pages/chat/chat-pane.test-support.ts";
import { notifyRenderLifecycleForTest } from "../pages/chat/render-lifecycle.ts";
import { createControlUiMockGatewayInitScript } from "./control-ui-e2e.ts";
import { createTestGatewayClient } from "./gateway-client.ts";
import { mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

it("keeps private pane probes on the reported runtime while composing stream instrumentation", ({
  gatewayPage,
}) => {
  const { window, execute } = gatewayPage;
  // SAFETY: The isolated page installs the existing opt-in instrumentation property.
  const scope = window as typeof window & {
    openclawRenderLifecycleTestHook?: typeof notifyRenderLifecycleForTest;
  };
  const firstProbe = vi.fn();
  scope.openclawRenderLifecycleTestHook = firstProbe;
  execute(createControlUiMockGatewayInitScript());
  const fixture = createTestChatPane({ client: createTestGatewayClient(() => ({})) });
  const element = window.document.createElement("openclaw-chat-pane");
  const runtime = new ChatPaneRuntime(element, fixture.pane.context);
  Reflect.set(runtime, "state", fixture.state);
  onTestFinished(() => {
    runtime.disconnectedCallback();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  vi.stubGlobal("openclawRenderLifecycleTestHook", scope.openclawRenderLifecycleTestHook);

  notifyRenderLifecycleForTest(runtime, "commit");
  expect(Reflect.get(element, "state")).toBe(fixture.state);
  expect(Reflect.get(element, "chatState")).toBe(Reflect.get(runtime, "chatState"));
  expect(Reflect.get(element, "context")).toBe(fixture.pane.context);
  expect(firstProbe).toHaveBeenCalledWith(runtime, "commit");

  const streamProbe = vi.fn();
  scope.openclawRenderLifecycleTestHook = streamProbe;
  Reflect.set(runtime, "state", undefined);
  notifyRenderLifecycleForTest(runtime, "invalidate");
  expect(Reflect.get(element, "state")).toBeUndefined();
  expect(firstProbe).toHaveBeenCalledTimes(1);
  expect(streamProbe).toHaveBeenCalledWith(runtime, "invalidate");

  const ownerUpdate = vi.spyOn(runtime, "requestUpdate");
  const originalUpdate: unknown = Reflect.get(element, "requestUpdate");
  if (typeof originalUpdate !== "function") {
    throw new Error("Expected the recorded pane's update operation");
  }
  let probeUpdates = 0;
  Reflect.set(element, "requestUpdate", (...args: unknown[]) => {
    probeUpdates += 1;
    if (probeUpdates > 1) {
      throw new Error("The saved owner update recursed through its replacement");
    }
    Reflect.apply(originalUpdate, element, args);
  });
  const instrumentedUpdate: unknown = Reflect.get(element, "requestUpdate");
  if (typeof instrumentedUpdate !== "function") {
    throw new Error("Expected the instrumented pane's update operation");
  }
  Reflect.apply(instrumentedUpdate, element, ["sessionKey", "previous"]);
  expect(probeUpdates).toBe(1);
  expect(ownerUpdate).toHaveBeenCalledWith("sessionKey", "previous");
  expect(ownerUpdate.mock.instances[0]).toBe(runtime);
});
