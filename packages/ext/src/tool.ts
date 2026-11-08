/**
 * The one tool surface of the platform: pi-durable's `ToolRegistration` shape
 * plus a `gated` flag. Plugins define tools with `defineTool`; the harness
 * validates `parameters` before `execute`. `gated` marks side-effecting tools —
 * the approval broker wraps those AT THE ACT; reads must leave it unset.
 *
 * pi-durable is a type-only dependency of this package (erased at runtime):
 * tools stay harness-shaped without coupling the registry to the harness.
 */
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { Schema } from "@earendil-works/pi-schema";

export type Tool<TParameters extends Schema = Schema> = ToolRegistration<TParameters> & {
  /** Side-effecting: execution waits for the user's approval. */
  readonly gated?: boolean;
};

export const defineTool = <const TParameters extends Schema>(
  tool: Tool<TParameters>,
): Tool<TParameters> => tool;
