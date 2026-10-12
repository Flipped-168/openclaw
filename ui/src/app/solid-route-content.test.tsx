/* @vitest-environment jsdom */
import { createRouter, definePage, type Router } from "@openclaw/uirouter";
import type { JSX } from "@solidjs/web";
import type { LitElement } from "lit";
import { createSignal, onCleanup } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import type { SolidRouteProps } from "../app-routes.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import type { ControlUiReadinessOutlet } from "./control-ui-readiness.ts";
import "./router-outlet.ts";

type RouteModule = { renderSolid: (props: SolidRouteProps) => JSX.Element };
type TestContext = { label: string };
type TestRouter = Router<"page" | "next", TestContext, RouteModule, string>;
type TestOutlet = LitElement &
  ControlUiReadinessOutlet & { router: TestRouter; retryContext: TestContext };

it("preserves a routed page's focused draft through loader updates and retires it on navigation", async () => {
  const firstCleanup = vi.fn();
  const secondCleanup = vi.fn();
  function FirstPage(props: SolidRouteProps) {
    const [draft, setDraft] = createSignal("");
    onCleanup(firstCleanup);
    return (
      <section>
        <input
          aria-label="Page draft"
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <output>{draft()}</output>
        <p>
          {String(props.data)} / {props.loaderPending ? "loading" : "ready"}
        </p>
      </section>
    );
  }
  function SecondPage(props: SolidRouteProps) {
    onCleanup(secondCleanup);
    return <p>Replacement page: {String(props.data)}</p>;
  }
  const reload = createDeferredCore<string>();
  let loads = 0;
  const router: TestRouter = createRouter({
    routes: [
      definePage({
        id: "page",
        path: "/page",
        component: () => ({ renderSolid: FirstPage }),
        loader: () => (++loads === 1 ? "Initial" : reload.promise),
      }),
      definePage({
        id: "next",
        path: "/next",
        component: () => ({ renderSolid: SecondPage }),
        loader: () => "Next",
      }),
    ],
  });
  const context = { label: "test" };
  // SAFETY: The registered outlet supplies Lit lifecycle and the readiness contract.
  const outlet = document.createElement("openclaw-router-outlet") as TestOutlet;
  outlet.router = router;
  outlet.retryContext = context;
  document.body.append(outlet);
  try {
    await router.navigate("page", context);
    await settleLitElement(outlet);
    const input = outlet.querySelector<HTMLInputElement>("input")!;
    input.focus();
    input.value = "Unsaved notes";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();

    const revalidation = router.revalidate(context, "page");
    await settleLitElement(outlet);
    expect(outlet.querySelector("p")?.textContent).toBe("Initial / loading");
    expect(outlet.querySelector("input")).toBe(input);
    expect(input.value).toBe("Unsaved notes");
    expect(document.activeElement).toBe(input);
    expect(firstCleanup).not.toHaveBeenCalled();

    reload.resolve("Loaded");
    await revalidation;
    await settleLitElement(outlet);
    expect(outlet.querySelector("p")?.textContent).toBe("Loaded / ready");
    expect(outlet.querySelector("input")).toBe(input);
    expect(input.value).toBe("Unsaved notes");
    expect(document.activeElement).toBe(input);
    expect(firstCleanup).not.toHaveBeenCalled();

    await router.navigate("next", context);
    await settleLitElement(outlet);
    expect(outlet.querySelector("input")).toBeNull();
    expect(outlet.querySelector("p")?.textContent).toBe("Replacement page: Next");
    expect(firstCleanup).toHaveBeenCalledOnce();
  } finally {
    outlet.remove();
    router.stop();
    await Promise.resolve();
  }
  expect(secondCleanup).toHaveBeenCalledOnce();
});
