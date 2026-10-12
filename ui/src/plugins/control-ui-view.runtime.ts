import { mountLitContent } from "../lit/solid-content.tsx";

/** Preserve the unchanged plugin SDK's opaque templates and event receiver. */
export function renderPluginTemplate(template: unknown, target: HTMLElement, host?: object): void {
  mountLitContent(template, target, { host });
}
