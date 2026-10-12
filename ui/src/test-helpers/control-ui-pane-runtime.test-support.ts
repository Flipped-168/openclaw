import type { notifyRenderLifecycleForTest } from "../pages/chat/render-lifecycle.ts";

/** Keeps the existing private pane probes on their actual owner during the Solid migration. */
export function installControlUiPaneRuntimeTestAdapter() {
  // SAFETY: The existing opt-in render instrumentation uses this shared hook contract.
  const scope = window as Window & {
    openclawRenderLifecycleTestHook?: typeof notifyRenderLifecycleForTest;
  };
  const owners = new WeakMap<HTMLElement, WeakRef<object>>();
  let probe = scope.openclawRenderLifecycleTestHook;

  const forwardPaneProbes = (element: HTMLElement) => {
    const readOwner = () => owners.get(element)?.deref();
    for (const key of ["state", "chatState", "context"] as const) {
      Object.defineProperty(element, key, {
        configurable: true,
        get() {
          const owner = readOwner();
          return owner && Reflect.get(owner, key);
        },
      });
    }
    const forwardUpdate =
      (update: unknown) =>
      (...args: unknown[]) => {
        const owner = readOwner();
        if (owner && typeof update === "function") {
          Reflect.apply(update, owner, args);
        }
      };
    Object.defineProperty(element, "requestUpdate", {
      configurable: true,
      get() {
        const owner = readOwner();
        const update: unknown = owner && Reflect.get(owner, "requestUpdate");
        return typeof update === "function" ? forwardUpdate(update) : update;
      },
      set(update: unknown) {
        const owner = readOwner();
        if (owner) {
          Reflect.set(owner, "requestUpdate", update);
        }
      },
    });
  };

  const notify: typeof notifyRenderLifecycleForTest = (host, phase) => {
    const element: unknown = host instanceof HTMLElement ? host : Reflect.get(host, "element");
    if (element instanceof HTMLElement && element.localName === "openclaw-chat-pane") {
      if (!(host instanceof HTMLElement)) {
        if (!owners.has(element)) {
          forwardPaneProbes(element);
        }
        if (owners.get(element)?.deref() !== host) {
          owners.set(element, new WeakRef(host));
        }
      }
    }
    probe?.(host, phase);
  };
  // The mock fixture keeps capture installed while the existing stream probe replaces its callback.
  Object.defineProperty(scope, "openclawRenderLifecycleTestHook", {
    configurable: true,
    get: () => notify,
    set(next: typeof notifyRenderLifecycleForTest | undefined) {
      probe = next;
    },
  });
}
