import { createEffect, createSignal, onCleanup, onSettled } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { focusHeadingAfterRemoval } from "./plugin-removal-focus.ts";
import { PluginsPageView } from "./plugins-page-view.tsx";
import { PluginsPageController } from "./plugins-page.ts";
import type { PluginsRouteData } from "./route-data.ts";
import "../../styles/plugins.css";

export type PluginsPageProps = { routeData?: PluginsRouteData; surface?: "discovery" | "settings" };

export const PluginsPage = defineSolidBridge<PluginsPageProps>(
  "openclaw-plugins-page",
  (props, host) => {
    const context = useApplication();
    // Domain notifications can arrive while a legacy child commits.
    const [revision, setRevision] = createSignal(0, { ownedWrite: true });
    const page = new PluginsPageController({
      context: () => context,
      notify: () => setRevision((value) => value + 1),
      onRemoval: (trigger) => onSettled(() => focusHeadingAfterRemoval(host, trigger)),
    });
    page.element = host;
    createEffect(
      () => [props.routeData, props.surface] as const,
      ([routeData, surface]) => page.update(routeData, surface ?? "settings"),
    );
    createEffect(revision, () => page.afterCommit());
    onCleanup(() => page.dispose());
    return <PluginsPageView page={page} revision={revision} />;
  },
  {
    properties: {
      routeData: { default: undefined, attribute: false },
      surface: { default: "settings", attribute: false },
    },
  },
);
