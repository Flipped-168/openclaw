import { mountLitContent, unmountLitContent } from "../lit/solid-content.tsx";

/** Preserve the unchanged plugin SDK's opaque templates and event receiver. */
export function renderPluginTemplate(template: unknown, target: HTMLElement, host?: object): void {
  if (template === undefined) {
    unmountLitContent(target);
  } else {
    mountLitContent(template, target, { host });
  }
}
