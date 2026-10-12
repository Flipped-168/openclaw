import { vi } from "vitest";
import { installPopoverPolyfill } from "./popover.ts";
import { installSafeLocalStorageForTesting } from "./storage.ts";

installPopoverPolyfill();

if (typeof document !== "undefined" && !("__vitest_browser__" in globalThis)) {
  // mock-isolation: JSDOM rendering tests assume admission; the real browser gate has E2E coverage.
  vi.doMock("../app/boot-capabilities.ts", () => ({ unsupportedControlUiBrowser: false }));
}

// Lit emits a one-time dev-mode warning in test builds. Pre-mark it as issued
// so broad UI suites stay signal-heavy instead of repeating the same console.warn.
const issuedWarnings = ((globalThis as { litIssuedWarnings?: Set<string> }).litIssuedWarnings ??=
  new Set<string>());

issuedWarnings.add("dev-mode");

// Web Awesome resolves `for` targets while Lit content is still in a detached
// render root. The app renders into a connected root; JSDOM unit helpers do not.
const findElementById = (root: ParentNode, id: string) =>
  [...root.querySelectorAll<HTMLElement>("[id]")].find((element) => element.id === id) ?? null;

if (typeof DocumentFragment !== "undefined" && !("getElementById" in DocumentFragment.prototype)) {
  Object.defineProperty(DocumentFragment.prototype, "getElementById", {
    configurable: true,
    value(this: DocumentFragment, id: string) {
      return findElementById(this, id);
    },
  });
}

if (typeof Element !== "undefined" && !("getElementById" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "getElementById", {
    configurable: true,
    value(this: Element, id: string) {
      return findElementById(this, id);
    },
  });
}

// JSDOM has no Web Animations API. Web Awesome uses this probe to skip
// animations when none are active.
if (typeof Element !== "undefined" && !("getAnimations" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
}

// JSDOM exposes partial ElementInternals. Web Awesome form controls require
// the form-associated methods even when tests do not mount them in a form.
// Browser tests need native CustomStateSet so CSS :state() observes real state.
if (typeof HTMLElement !== "undefined" && !("__vitest_browser__" in globalThis)) {
  Object.defineProperty(HTMLElement.prototype, "attachInternals", {
    configurable: true,
    value() {
      const validity = { valid: true } as ValidityState;
      return {
        checkValidity: () => true,
        form: null,
        labels: null,
        reportValidity: () => true,
        setFormValue: () => {},
        setValidity: () => {},
        states: new Set<string>(),
        validationMessage: "",
        validity,
        willValidate: true,
      };
    },
  });
}

if (typeof HTMLDialogElement !== "undefined" && !("showModal" in HTMLDialogElement.prototype)) {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
}

if (typeof HTMLDialogElement !== "undefined" && !("close" in HTMLDialogElement.prototype)) {
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
}

// JSDOM renderer tests exercise domain callbacks without a browser top layer.
// Native visibility, focus, and dismissal contracts run in the browser suites.
if (typeof HTMLElement !== "undefined" && !("showPopover" in HTMLElement.prototype)) {
  const openPopovers = new WeakSet<HTMLElement>();
  // oxlint-disable-next-line typescript/unbound-method -- Every call supplies the actual element receiver below.
  const matches = Element.prototype.matches;
  Object.defineProperty(Element.prototype, "matches", {
    configurable: true,
    value(this: Element, selector: string) {
      return selector === ":popover-open"
        ? this instanceof HTMLElement && openPopovers.has(this)
        : matches.call(this, selector);
    },
  });
  const setOpen = (element: HTMLElement, open: boolean) => {
    const wasOpen = openPopovers.has(element);
    if (wasOpen === open) {
      return;
    }
    const states = { oldState: wasOpen ? "open" : "closed", newState: open ? "open" : "closed" };
    if (
      !element.dispatchEvent(Object.assign(new Event("beforetoggle", { cancelable: open }), states))
    ) {
      return;
    }
    if (open) {
      openPopovers.add(element);
    } else {
      openPopovers.delete(element);
    }
    element.dispatchEvent(Object.assign(new Event("toggle"), states));
  };
  Object.defineProperties(HTMLElement.prototype, {
    showPopover: {
      configurable: true,
      value(this: HTMLElement) {
        setOpen(this, true);
      },
    },
    hidePopover: {
      configurable: true,
      value(this: HTMLElement) {
        setOpen(this, false);
      },
    },
  });
}

// Node 25+ exposes accessor-backed WebStorage that can be disabled or inert.
// Vitest intentionally rejects all storage accessors, so jsdom needs an owned
// value descriptor even when invoking the original getter appears to work.
function globalLocalStorageIsUsable(): boolean {
  try {
    const existing = globalThis.localStorage;
    if (!existing) {
      return false;
    }
    existing.setItem("__openclaw_probe__", "1");
    const roundTrips = existing.getItem("__openclaw_probe__") === "1";
    existing.removeItem("__openclaw_probe__");
    return roundTrips;
  } catch {
    return false;
  }
}

if (
  typeof window !== "undefined" &&
  ((typeof process !== "undefined" && Boolean(process.env?.VITEST)) ||
    !globalLocalStorageIsUsable())
) {
  installSafeLocalStorageForTesting(window);
}
