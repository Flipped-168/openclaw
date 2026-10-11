import type { JSX as SolidJSX } from "@solidjs/web";
import { createComponent } from "solid-js";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import type { ModelPickerOption } from "./model-picker.ts";
import { MultiSelectView } from "./multi-select-view.tsx";

export type MultiSelectOption = ModelPickerOption;

export type MultiSelectProps = {
  options: readonly MultiSelectOption[];
  /** Current values in display order. Controlled: the host owns them. */
  value: readonly string[];
  isExcluded: (value: string) => boolean;
  /** The caller owns value identity; search remains case-insensitive. */
  getValueKey: (value: string) => string;
  placeholder: string;
  accessibleLabel: string;
  allowCustom: boolean;
  disabled: boolean;
  onChange: (value: string[]) => void;
  onOpen: () => void;
};

export type MultiSelect = SolidBridgeElement<MultiSelectProps>;

export const MultiSelect = defineSolidBridge<MultiSelectProps>(
  "openclaw-multi-select",
  (props) => createComponent(MultiSelectView, props),
  {
    properties: {
      options: { default: [], attribute: false },
      value: { default: [], attribute: false },
      isExcluded: { default: () => false, attribute: false },
      getValueKey: { default: (value) => value, attribute: false },
      placeholder: { default: "", attribute: false },
      accessibleLabel: { default: "", attribute: false },
      allowCustom: { default: false, attribute: false },
      disabled: { default: false, attribute: false },
      onChange: { default: () => {}, attribute: false },
      onOpen: { default: () => {}, attribute: false },
    },
  },
);

type MultiSelectAttributes = SolidJSX.HTMLAttributes<MultiSelect> & {
  [Key in keyof MultiSelect as `prop:${Key & string}`]?: MultiSelect[Key];
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-multi-select": MultiSelectAttributes;
    }
  }
}
