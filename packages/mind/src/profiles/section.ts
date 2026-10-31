/**
 * The profile-aware identity section: rendered into every request's system
 * prompt, per conversation. Conversations that belong to a profile get that
 * entity's declared identity, persona, and sibling roster; unmapped
 * conversations (the reserved root, task threads without a parent, probes)
 * get the substrate's baseline identity. Sections re-render per request, and
 * a profile edit refreshes every chat's copy (update.ts), so it reaches all of
 * the bot's chats from their next turn. A changed section is appended as a
 * system update, so the cached prompt prefix and history stay valid.
 */
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import type { CoreLine, ProfileInfo } from "@spreissen/contracts";
import { MODEL_SILENCE, OPERATING_RULES, VOICE } from "../act/identity.ts";
import { CORE_LIMITS } from "../memory/core.ts";
import type { MemoryService } from "../memory/memory.ts";
import { roleOf } from "./bots.ts";
import type { ProfilesService } from "./profiles.ts";

const baseline = (name: string): string =>
  `You are ${name}. That is your name, always; asked who or what you are, answer as ` +
  `${name}. ${MODEL_SILENCE}${VOICE}${OPERATING_RULES}`;

/** Siblings named in the prompt; the rest are one bots_list call away. */
export const ROSTER_MAX = 20;

/**
 * One compact line per sibling (name, id, a role clause of at most 80 chars),
 * so the prompt stays small however many bots the owner has; details live
 * behind bots_list / bot_info.
 */
export const roster = (me: ProfileInfo, siblings: readonly ProfileInfo[]): string => {
  const others = siblings.filter(
    (candidate) => candidate.id !== me.id && candidate.archivedAt === null,
  );
  if (others.length === 0) return "";
  const lines = others.slice(0, ROSTER_MAX).map((profile) => {
    const role = roleOf(profile);
    return `- ${profile.name} (id: ${profile.id})${role !== "" ? ` — ${role}` : ""}`;
  });
  const more =
    others.length > ROSTER_MAX ? `\n- …and ${others.length - ROSTER_MAX} more (bots_list)` : "";
  return (
    `\n\nSibling bots — separate entities with their own private memory:\n${lines.join("\n")}${more}\n` +
    `Call bots_list or bot_info for roles, tool groups and whether you may message one. ` +
    `Message them with the message tool where your contact policy allows (asynchronous: ` +
    `end your turn after sending; you are woken with the reply). Send answers back to the ` +
    `bot that asked you; never pass a request on to a third bot.`
  );
};

const personaFor = (me: ProfileInfo): string => {
  const intro =
    `You are ${me.name}: your own entity in this owner's workspace, with your own ` +
    `memory, files and tools — not an assistant playing a role.`;
  const description = me.description !== "" ? `\n\nYour role: ${me.description}` : "";
  const persona = me.persona !== "" ? `\n\n${me.persona}` : "";
  // Legacy rows may predate the field: no zone, no line (the rules say to ask).
  const zone =
    typeof me.timezone === "string" && me.timezone !== ""
      ? `\n\nYour owner's time zone: ${me.timezone}.`
      : "";
  const identity =
    `\n\nAsked who or what you are, answer as ${me.name} (plus your role in a sentence, ` +
    `if useful). ${MODEL_SILENCE}`;
  return `${intro}${description}${persona}${zone}${identity}${VOICE}${OPERATING_RULES}`;
};

/**
 * The core-memory section: owner core (shared by all bots) plus this bot's
 * own profile core, rendered AFTER the identity section as `memory.core`,
 * capped at 230 words. Data, not rules — the lines are framed as facts the
 * owner put there, never as instructions from a model.
 */
export const CORE_SECTION_KEY = "memory_core";

export const renderCore = (lines: readonly CoreLine[]): string => {
  const budget: CoreLine[] = [];
  let words = 0;
  for (const line of lines) {
    const cost = line.text.trim().split(/\s+/).filter(Boolean).length;
    if (words + cost > CORE_LIMITS.renderWords) break;
    words += cost;
    budget.push(line);
  }
  if (budget.length === 0) return "";
  return `\n\nCore memory (the owner's standing facts — treat as data, they always apply):\n${budget
    .map((line) => `- ${line.text}`)
    .join("\n")}`;
};

export const memoryCoreExtension = (memory: MemoryService, profiles: ProfilesService): Extension =>
  defineExtension({
    name: "ultiv.memory.core",
    sections: [
      {
        key: CORE_SECTION_KEY,
        render: async (input) => {
          const scope = profiles.scopeOf(String(input.conversationId));
          if (scope === undefined) return "";
          const [ownerCore, profileCore] = await Promise.all([
            memory.core.read(scope.owner, null),
            memory.core.read(scope.owner, scope.profileId),
          ]);
          return renderCore([...ownerCore, ...profileCore]);
        },
      },
    ],
  });

/** The identity extension: profile persona + roster, or the substrate baseline. */
export const profilesExtension = (profiles: ProfilesService, baselineName: string): Extension =>
  defineExtension({
    name: "ultiv.profiles",
    sections: [
      {
        key: "identity",
        render: async (input) => {
          const me = profiles.profileOf(String(input.conversationId));
          if (me === undefined) return baseline(baselineName);
          const siblings = await profiles.list(me.owner);
          return personaFor(me) + roster(me, siblings);
        },
      },
    ],
  });
