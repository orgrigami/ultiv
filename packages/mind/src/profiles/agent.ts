/** The agent a profile's new conversations start with: model default + tool allowlist. */
import type { AgentChange } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ProfileInfo, SessionKind } from "@spriessen/contracts";
import { parseRef } from "../providers/refs.ts";
import { chatModelTools, isChatKind } from "./chat-tools.ts";

/** Tools a profile loses whatever its allowlist says: sandboxed tools without a sandbox. */
const SANDBOX_TOOLS = ["bash", "browser_open"];

export const agentForProfile = (
  profile: ProfileInfo,
  tools: () => readonly { readonly name: string }[],
  /** Names an allowlist implies (allowlisting a connector tool implies `connector_load`). */
  implied: (allowlist: readonly string[]) => readonly string[] = () => [],
  /** Host-direct tool names dropped while the bot's host-access switch is off (slice 10). */
  hostExcluded: readonly string[] = [],
  /**
   * Every tool on the registry (all extensions, late installs included). The
   * allowlist governs only the `tools()` catalog; the mind's own faculties
   * (message, rooms, memory, tasks, schedules, ...) are never allowlistable
   * and always stay. Absent in bare tests: the catalog is the registry.
   */
  allTools?: () => readonly { readonly name: string }[],
  /**
   * The kind of conversation this agent is for: a chat (anything but a task)
   * is offered only the chat tools (chat-tools.ts); a task, or no kind, the
   * whole allowed set.
   */
  kind?: SessionKind,
): AgentChange => {
  // Sandbox off removes the tool outright (never falls back to the host
  // shell — that would quietly change what every approval was approving).
  // The host-access switch removes its own set the same way: absent from the
  // list, not merely gated (slice 10).
  const excluded =
    profile.policies.sandbox === false ? [...SANDBOX_TOOLS, ...hostExcluded] : hostExcluded;
  const names =
    profile.toolAllowlist === null
      ? null
      : [...profile.toolAllowlist, ...implied(profile.toolAllowlist)];
  // No allowlist: a REMOVE filter, never a fixed list — a fixed list built
  // from the catalog silently dropped every faculty tool (`message` among
  // them) and every late install. Nothing to remove clears a stale stored
  // filter (`null`), so a re-apply heals an old conversation.
  const allowed: AgentChange["tools"] =
    names === null
      ? excluded.length === 0
        ? null
        : ({ remove: excluded.map((name) => ({ name })) } as unknown as NonNullable<
            AgentChange["tools"]
          >)
      : (() => {
          const catalog = new Set(tools().map((tool) => tool.name));
          const seen = new Set<string>();
          return [...tools(), ...(allTools?.() ?? [])].filter((tool) => {
            if (seen.has(tool.name) || excluded.includes(tool.name)) return false;
            const keep = !catalog.has(tool.name) || names.includes(tool.name);
            if (keep) seen.add(tool.name);
            return keep;
          }) as unknown as NonNullable<AgentChange["tools"]>;
        })();
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
    tools: allowed,
    ...(isChatKind(kind) ? { modelTools: chatModelTools() } : {}),
  };
};
