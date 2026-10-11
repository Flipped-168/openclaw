import type { JSX } from "@solidjs/web";
import { html } from "lit";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { PickerContent } from "./select-picker-view.tsx";
import "../styles/select-picker.css";

export type PickerOption = {
  value: string;
  label: string;
  description?: string;
  labelStyle?: string;
  disabled?: boolean;
};

export type PickerGroup = { id: string; label: string; leading?: unknown };
export type PickerParams<Option extends PickerOption> = {
  id?: string;
  label: string;
  value: string | null;
  options: readonly Option[];
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
  title?: string;
  placement?: "top" | "bottom";
  variant?: "submenu";
  /** Show the choices as a page of the enclosing sheet instead of a floating popup. */
  sheet?: boolean;
  /** `true` searches long lists; `"always"` keeps the field for short lists too. */
  searchable?: boolean | "always";
  searchPlaceholder?: string;
  groupBy?: (option: Option) => PickerGroup | undefined;
  showOptionTooltips?: boolean;
  showSelectedDescription?: boolean;
  onOpen?: () => void;
  onChange: (value: string) => void;
  onChangeTarget?: (value: string, select: HTMLElement) => void;
  renderLeading?: (option: Option) => unknown;
};

export type SelectPicker<Option extends PickerOption = PickerOption> = SolidBridgeElement<{
  params: PickerParams<Option>;
}>;

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-select-picker": SelectPicker;
  }
}

const PickerBridge = defineSolidBridge<{ params: PickerParams<PickerOption> }>(
  "openclaw-select-picker",
  (props, host) =>
    PickerContent({
      get params() {
        return props.params;
      },
      host,
    }),
  {
    properties: {
      params: { default: { label: "", value: null, options: [], onChange() {} }, attribute: false },
    },
  },
);

// SAFETY: The bridge transports params unchanged; each caller supplies its own option subtype.
const TypedPicker = PickerBridge as <Option extends PickerOption>(props: {
  params: PickerParams<Option>;
  class?: string;
  style?: string;
}) => JSX.Element;

export function Picker<Option extends PickerOption>(props: {
  params: PickerParams<Option>;
  class?: string;
  style?: string;
}) {
  return TypedPicker({
    get params() {
      return props.params;
    },
    get class() {
      return props.class ?? pickerClass(props.params);
    },
    get style() {
      return props.style ?? "width:100%;min-width:min(138px,100%)";
    },
  });
}

export function pickerClass(params: { variant?: "submenu"; sheet?: boolean; className?: string }) {
  return `settings-select picker-select ${params.variant === "submenu" ? "picker-select--submenu" : ""} ${params.sheet ? "picker-select--sheet" : ""} ${params.className ?? ""}`;
}

export function renderPicker<Option extends PickerOption>(params: PickerParams<Option>) {
  return html`<openclaw-select-picker
    class=${pickerClass(params)}
    style="width:100%;min-width:min(138px,100%)"
    .params=${params}
  ></openclaw-select-picker>`;
}
