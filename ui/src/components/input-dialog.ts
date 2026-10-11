import { render as renderSolid, type JSX } from "@solidjs/web";
import { createComponent } from "solid-js";
import { InputDialogView } from "./input-dialog-view.tsx";
import { withPromiseModalHost } from "./promise-modal-host.ts";

export type InputDialogOptions = {
  title: string;
  label?: string;
  defaultValue?: string;
  submitLabel?: string;
  cancelLabel?: string;
  signal?: AbortSignal;
  /**
   * Trims the value and blocks submission while it is empty. Callers that treat
   * an empty entry as meaningful (clearing a custom session label) leave this
   * off and keep receiving the raw value.
   */
  requireValue?: boolean;
  /**
   * Holds submission closed while the entry still equals `defaultValue`, so a
   * rename that would change nothing cannot be submitted.
   */
  requireChange?: boolean;
  /**
   * Runs the operation the dialog was opened for. `null` resolves the dialog; a
   * message keeps it open with the typed value, so a rejected attempt stays
   * visible and retryable instead of discarding what the operator wrote.
   */
  submit?: (value: string) => Promise<string | null>;
};

let inputActive = false;

function presentInputDialog(options: InputDialogOptions): Promise<string | null> {
  return withPromiseModalHost<string | null, JSX.Element>(
    { signal: options.signal, value: null },
    (modal) =>
      modal.render(() =>
        createComponent(InputDialogView, {
          options,
          finish: modal.finish,
          settled: () => modal.settled,
        }),
      ),
    (content, host) => renderSolid(content, host),
  );
}

/** Native prompts block reentrancy; reject a second request instead of stacking it. */
export function showInputDialog(options: InputDialogOptions): Promise<string | null> {
  if (inputActive) {
    return Promise.resolve(null);
  }
  inputActive = true;
  return presentInputDialog(options).finally(() => {
    inputActive = false;
  });
}
