/**
 * Model/effort selection of a conversation: read back (`agentOf`) and apply
 * (`configure`), snapping efforts the target model does not support.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Effect } from "effect";
import type { AgentChange } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { formatRef, parseRef, snapEffort, type ModelSpec } from "../providers/refs.ts";
import { asEffect } from "./as-effect.ts";
import type { ConverseService } from "./converse.ts";

/** `provider/model` off the resolved agent's model (a pi-ai `Model` or a `ModelRef`). */
const modelRefOf = (agent: { readonly model?: unknown }): string | null => {
  const model = agent.model as
    | { readonly provider?: string; readonly modelId?: string; readonly id?: string }
    | undefined;
  if (model === undefined || model === null) return null;
  const modelId = model.modelId ?? model.id;
  if (modelId === undefined) return null;
  return model.provider !== undefined ? formatRef({ provider: model.provider, modelId }) : modelId;
};

export const selectionOps = (
  findModel: (ref: string) => ModelSpec | undefined,
): Pick<ConverseService, "agentOf" | "configure"> => {
  /** An effort the model does not support (e.g. carried over from another model) snaps to its default. */
  const effortFor = <E extends string | null | undefined>(
    model: string | null | undefined,
    effort: E,
  ) => snapEffort(model === null || model === undefined ? undefined : findModel(model), effort);
  return {
    agentOf: (conversation) =>
      Effect.flatMap(asEffect("agent read", conversation.agent(BACKGROUND_CONTEXT)), (resolved) => {
        const model = modelRefOf(resolved);
        // A stored effort may predate the model it now runs on; surface the
        // model's own default instead of an out-of-list value.
        const effort = effortFor(
          model,
          (resolved.thinkingLevel ?? null) as ModelThinkingLevel | null,
        );
        return Effect.succeed({ model, effort });
      }),
    configure: (conversation, selection) => {
      // Effort must be one the TARGET model supports: an effort carried over
      // from another model (e.g. `off` on an always-reasoning model) degrades
      // it. Snap out-of-list efforts to the model's own default.
      const effort =
        selection.model !== undefined
          ? effortFor(selection.model, selection.effort)
          : selection.effort;
      const change: AgentChange = {
        ...(selection.model !== undefined
          ? {
              model: selection.model === null ? null : parseRef(selection.model),
            }
          : {}),
        ...(effort !== undefined ? { thinkingLevel: effort } : {}),
        ...(selection.tools !== undefined ? { tools: selection.tools } : {}),
      };
      return Effect.asVoid(
        asEffect("agent configure", conversation.configure(change, BACKGROUND_CONTEXT)),
      );
    },
  };
};
