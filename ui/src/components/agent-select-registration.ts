import type { AgentSelectElement, AgentSelectOption } from "./agent-select.ts";
import "./agent-select.tsx";

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-agent-select": AgentSelectElement;
  }
}
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-agent-select": HTMLAttributes<AgentSelectElement> & {
        "prop:options": AgentSelectOption[];
        "prop:value": string;
        "prop:accessibleLabel": string;
        "prop:disabled": boolean;
        "prop:onSelect": (value: string) => void;
      };
    }
  }
}
