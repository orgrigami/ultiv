/**
 * Codemode for the act: pi-durable's durable code mode — one tool whose input
 * is JavaScript, run in a QuickJS-WASM sandbox (no network, no filesystem, no
 * timers) whose ONLY capability is calling the conversation's tools as
 * `tools.<name>(args)`. Scripts compose, fan out and filter tool results
 * without round-tripping everything through model context; a script survives
 * a restart via the harness's replay journal.
 *
 * Gated tools called from a script still hit the approval broker: nested
 * calls execute the same wrapped tool objects the act installed, so a script
 * waiting on `web_fetch`'s gated cousin parks the same pending approval the
 * UI already renders.
 */
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
  createCodemodeExtension,
  type CodemodeNamespace,
} from "@earendil-works/pi-durable/codemode";
import type { Extension } from "@earendil-works/pi-durable";

/**
 * The codemode extension over the act's tools. One namespace: everything the
 * registry installed, addressed as `tools.<name>`. `models: true` also gives
 * scripts the catalog (`models.getAvailableOfType`, …) and the paid globals
 * (`models.classify` for Jev, `models.generateImages` when an image provider
 * exists), each journaled as an internal durable call.
 */
export const codemodeExtension = (namespaces: readonly CodemodeNamespace[] = []): Extension =>
  createCodemodeExtension({
    sandbox: new CodemodeSandbox(),
    namespaces: [
      {
        // The section's budget selector lists tools cheapest-first per group,
        // so `bash` (~360 tokens) — the priciest core declaration and the one
        // scripts most need — was dropped from the listing on every render at
        // the default budget: bots never learned they can shell from a script
        // (raising the budget does not help — the ~60 cheaper unnamespaced
        // tools fill any budget first). A namespace is round-robin guaranteed
        // representation, so the declaration always renders at the same
        // prompt cost.
        name: "shell",
        prefix: "bash",
        description:
          "Run shell scripts with `bash` and its optional target: in the sandboxed workspace VM " +
          "(the default), directly on the host computer, or on a node your owner paired (each " +
          "call waits for the owner's approval).",
      },
      ...namespaces,
    ],
  });
