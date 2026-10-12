import type { JSX } from "@solidjs/web";
import { createEffect, For, onSettled } from "solid-js";
import "../../styles/hub-tabs.css";
import { reclaimHubTabFocus, rememberHubTabFocus } from "../hub-tabs-focus.ts";
import { syncTabGroupLabel } from "../web-awesome-tabs.ts";

type HubTabOption<T extends string> = {
  value: T;
  label: JSX.Element;
  badge?: JSX.Element;
  count?: number | null;
  disabled?: boolean;
  testId?: string;
};
export type HubTabsProps<T extends string> = {
  id: string;
  active: T | null;
  requestedActive?: T;
  tabs: ReadonlyArray<HubTabOption<T>>;
  ariaLabel: string;
  panelId: string;
  class?: string;
  carapace?: boolean;
  variant?: "primary" | "sub";
  onSelect: (tab: T) => void;
  onActivate?: (element: HTMLElement) => void;
};

const NO_ACTIVE_TAB = "__openclaw-hub-tabs-no-active__";

function HubTab<T extends string>(props: { hub: HubTabsProps<T>; tab: HubTabOption<T> }) {
  let element: HTMLElement | undefined;
  const selected = () => props.hub.active === props.tab.value;
  const fallbackFocus = () =>
    props.hub.active === null ? props.hub.tabs.find((tab) => !tab.disabled)?.value : null;
  const activate = (event: MouseEvent | KeyboardEvent, keyboard = false) => {
    const target = event.currentTarget;
    if (
      !(target instanceof HTMLElement) ||
      props.tab.disabled ||
      props.tab.value === (props.hub.requestedActive ?? props.hub.active)
    ) {
      return;
    }
    if (keyboard) {
      event.preventDefault();
      rememberHubTabFocus(props.hub.id, props.tab.value, target);
    }
    props.hub.onSelect(props.tab.value);
    props.hub.onActivate?.(target);
  };
  onSettled(() => {
    if (selected()) {
      reclaimHubTabFocus(props.hub.id, props.tab.value, element);
    }
  });
  return (
    <wa-tab
      ref={(node) => {
        element = node;
      }}
      id={`${props.hub.id}-tab-${props.tab.value}`}
      panel={props.tab.value}
      aria-controls={props.hub.panelId}
      class={["hub-tab", { "oc-segmented-item": props.hub.carapace }]}
      active={selected()}
      disabled={props.tab.disabled}
      prop:tabIndex={selected() || props.tab.value === fallbackFocus() ? 0 : -1}
      aria-selected={selected() ? "true" : "false"}
      data-test-id={props.tab.testId}
      onClick={(event: MouseEvent) => {
        if (event.detail > 0 || event.isTrusted) {
          activate(event);
        }
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (!event.repeat && (event.key === "Enter" || event.key === " ")) {
          activate(event, true);
        }
      }}
    >
      {props.tab.label}
      {props.tab.count == null ? null : (
        <span class="hub-tab__badge hub-tab__badge--count">{props.tab.count}</span>
      )}
      {props.tab.badge == null ? null : <span class="hub-tab__badge">{props.tab.badge}</span>}
    </wa-tab>
  );
}

export function HubTabs<T extends string>(props: HubTabsProps<T>) {
  let group: HTMLElement | undefined;
  createEffect(
    () => props.ariaLabel,
    (label) => syncTabGroupLabel(group, label),
  );
  return (
    <wa-tab-group
      ref={(node) => {
        group = node;
      }}
      class={[
        "hub-tabs",
        `hub-tabs--${props.variant ?? "primary"}`,
        `${props.id}-hub-tabs`,
        props.class,
        { "oc-segmented": props.carapace },
      ]}
      aria-label={props.ariaLabel}
      prop:active={props.active ?? NO_ACTIVE_TAB}
      activation="manual"
      without-scroll-controls
    >
      <For each={props.tabs} keyed={(tab) => tab.value}>
        {(tab) => <HubTab hub={props} tab={tab()} />}
      </For>
    </wa-tab-group>
  );
}
