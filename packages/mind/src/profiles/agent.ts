/** The agent a profile's new conversations start with: model default + tool allowlist. */
import type { AgentChange } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ProfileInfo } from "@ultiv/contracts";
import { parseRef } from "../providers/refs.ts";

export const agentForProfile = (
  profile: ProfileInfo,
  tools: () => readonly { readonly name: string }[],
  /** Names an allowlist implies (allowlisting a connector tool implies `connector_load`). */
  implied: (allowlist: readonly string[]) => readonly string[] = () => [],
): AgentChange => {
  const names =
    profile.toolAllowlist === null
      ? null
      : [...profile.toolAllowlist, ...implied(profile.toolAllowlist)];
  const allowed =
    names === null
      ? undefined
      : (tools().filter((tool) => names.includes(tool.name)) as unknown as NonNullable<
          AgentChange["tools"]
        >);
  return {
    ...(profile.model !== null
      ? {
          model: parseRef(profile.model.id),
          // An empty effort string means "the model's default".
          ...(profile.model.effort !== ""
            ? { thinkingLevel: profile.model.effort as ModelThinkingLevel }
            : {}),
        }
      : {}),
    ...(allowed !== undefined ? { tools: allowed } : {}),
  };
};
