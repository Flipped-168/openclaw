import { render as renderSolid, type JSX } from "@solidjs/web";
import { createComponent } from "solid-js";
import { ConfirmDialogView } from "./confirm-dialog-view.tsx";
import { withPromiseModalHost } from "./promise-modal-host.ts";

/**
 * Opt-out for confirms whose action is repeatable and recoverable. Callers own
 * the storage; passing this is what makes the checkbox exist at all, so serious
 * confirms stay unskippable by simply not offering one.
 */
export type ConfirmDialogSkipPreference = {
  /** True when the operator already chose to stop being asked. */
  skipped: boolean;
  /** Persists that choice; runs only when they confirm with the box ticked. */
  remember: () => void;
};

export type ConfirmDialogOptions = {
  title?: string;
  message: string;
  details?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  signal?: AbortSignal;
  skipPreference?: ConfirmDialogSkipPreference;
  requiredAcknowledgement?: string;
};

let confirmationActive = false;

function presentConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return withPromiseModalHost<boolean, JSX.Element>(
    { signal: options.signal, value: false },
    ({ render, finish }) => render(() => createComponent(ConfirmDialogView, { options, finish })),
    (content, host) => renderSolid(content, host),
  );
}

/** Native confirms block reentrancy; reject a second request instead of replaying it later. */
export function showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  // An operator who opted out gets the action itself, not a modal they already
  // answered. Only callers that opted into a skip preference can reach this.
  if (options.skipPreference?.skipped && !options.requiredAcknowledgement) {
    return Promise.resolve(true);
  }
  if (confirmationActive) {
    return Promise.resolve(false);
  }
  confirmationActive = true;
  return presentConfirmDialog(options).finally(() => {
    confirmationActive = false;
  });
}
