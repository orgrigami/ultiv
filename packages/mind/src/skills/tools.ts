/**
 * The skill tools as native parts of the agent loop: list, load, read a
 * reference file, write (create or update), delete (gated), and propose
 * (park a change for the owner). Writes are ungated like artifact writes:
 * a bot growing its own craft in its own namespace is what memory writes
 * already are, one tier up. Deletes are gated like artifact deletes.
 * skill_install and skill_evolve live beside this file.
 */
import { Type } from "typebox";
import { defineTool, type Tool } from "@ultiv/ext";
import type { ProfilesService } from "../profiles/profiles.ts";
import type { ConversationScope } from "../profiles/docs.ts";
import { parseSkillDoc, serializeSkillDoc } from "./frontmatter.ts";
import { MAX_SKILL_CHARS, slugOk } from "./guard.ts";
import type { SkillsService } from "./service.ts";

/** The calling conversation's profile scope, or a refusal when unmapped. */
export const skillsScope = (
  profiles: ProfilesService,
  conversationId: string,
): { scope: ConversationScope } | { refused: string } => {
  const scope = profiles.scopeOf(conversationId);
  return scope === undefined
    ? { refused: "this conversation belongs to no profile, so it keeps no skills" }
    : { scope };
};

const listTool = (skills: SkillsService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "skill_list",
    description:
      "List your skills (name, description, origin, version). Your skill list also rides in " +
      "your prompt; use this when you need the full sheet or the ones beyond it.",
    parameters: Type.Object({}),
    structuredOutputSchema: Type.Array(
      Type.Object({
        name: Type.String(),
        description: Type.String(),
        origin: Type.String(),
        version: Type.Number(),
        enabled: Type.Boolean(),
      }),
    ),
    execute: async (_args, api) => {
      const resolved = skillsScope(profiles, String(api.conversationId));
      if ("refused" in resolved) {
        return {
          output: [{ type: "text" as const, text: resolved.refused }],
          isError: true as const,
        };
      }
      const { owner, profileId } = resolved.scope;
      const rows = (await skills.list(owner, profileId)).map((meta) => ({
        name: meta.name,
        description: meta.description,
        origin: meta.origin,
        version: meta.version,
        enabled: meta.enabled,
      }));
      return { ...text(JSON.stringify(rows, null, 1)), structuredOutput: rows };
    },
  });

const loadTool = (skills: SkillsService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "skill_load",
    description:
      "Load a skill's full instructions into context when a task matches its description. " +
      "Follow what it says; it is a procedure written for exactly this kind of work.",
    parameters: Type.Object({
      name: Type.String({ description: "The skill's name, as the skill list shows it." }),
    }),
    execute: async (args, api) => {
      const resolved = skillsScope(profiles, String(api.conversationId));
      if ("refused" in resolved) {
        return {
          output: [{ type: "text" as const, text: resolved.refused }],
          isError: true as const,
        };
      }
      const { owner, profileId } = resolved.scope;
      const found = await skills.read(owner, profileId, args.name);
      if (found === undefined) return text(`no skill named "${args.name}"`, true);
      if (!found.meta.enabled) {
        return text(`"${args.name}" is disabled for you by your owner`, true);
      }
      const extra =
        found.meta.files.length > 0
          ? `\n\nReference files: ${found.meta.files.join(", ")} (skill_file reads them).`
          : "";
      return text(`${found.body}${extra}`);
    },
  });

const fileTool = (skills: SkillsService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "skill_file",
    description: "Read one file that ships inside a skill (a reference doc or template).",
    parameters: Type.Object({
      name: Type.String({ description: "The skill's name." }),
      path: Type.String({ description: "Path relative to the skill folder (see skill_load)." }),
    }),
    execute: async (args, api) => {
      const resolved = skillsScope(profiles, String(api.conversationId));
      if ("refused" in resolved) {
        return {
          output: [{ type: "text" as const, text: resolved.refused }],
          isError: true as const,
        };
      }
      const { owner, profileId } = resolved.scope;
      const body = await skills.readFile(owner, profileId, args.name, args.path);
      return body === undefined
        ? text(`no file "${args.path}" in skill "${args.name}"`, true)
        : text(body);
    },
  });

const WriteParams = Type.Object({
  name: Type.String({
    description: "The skill's name: lowercase-and-hyphens, ≤48 chars (create or update).",
  }),
  body: Type.String({
    description: `The full SKILL.md text (frontmatter with name and description, then markdown), up to ${MAX_SKILL_CHARS} chars.`,
  }),
  description: Type.Optional(
    Type.String({
      description:
        "One-line description for the skill list; used when the body has no frontmatter.",
    }),
  ),
});

const writeTool = (skills: SkillsService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "skill_write",
    description:
      "Write a skill: a procedure of yours worth keeping (done twice, or your owner said " +
      '"do it this way from now on"). Creates or updates it in YOUR namespace; it joins your ' +
      "skill list next turn. Never put secrets in skill text. Updating keeps the previous " +
      "version, so an edit is reversible.",
    parameters: WriteParams,
    structuredOutputSchema: Type.Object({ name: Type.String(), version: Type.Number() }),
    execute: async (args, api) => {
      const resolved = skillsScope(profiles, String(api.conversationId));
      if ("refused" in resolved) {
        return {
          output: [{ type: "text" as const, text: resolved.refused }],
          isError: true as const,
        };
      }
      const { owner, profileId } = resolved.scope;
      if (!slugOk(args.name)) {
        return text(`"${args.name}" is not a skill name (lowercase-and-hyphens, ≤48)`, true);
      }
      let body = args.body;
      if (parseSkillDoc(body) === undefined) {
        if (args.description === undefined) {
          return text(
            "the body needs frontmatter (---\\nname: …\\ndescription: …\\n---) or pass `description`",
            true,
          );
        }
        body = serializeSkillDoc(args.name, args.description, body);
      }
      const existing = await skills.read(owner, profileId, args.name);
      const meta = await skills.write(owner, profileId, {
        name: args.name,
        body,
        ...(existing === undefined
          ? { authorProfile: profileId }
          : { origin: existing.meta.origin, authorProfile: existing.meta.authorProfile }),
      });
      return {
        ...text(`skill "${meta.name}" saved (v${meta.version}); in your list next turn`),
        structuredOutput: { name: meta.name, version: meta.version },
      };
    },
  });

const deleteTool = (skills: SkillsService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "skill_delete",
    gated: true,
    description:
      "Delete one of your skills by name. Your owner approves each deletion: first say which " +
      "skill and why. Built-in skills cannot be deleted (disable them instead).",
    parameters: Type.Object({
      name: Type.String({ description: "The skill's name." }),
    }),
    structuredOutputSchema: Type.Object({ name: Type.String(), deleted: Type.Boolean() }),
    execute: async (args, api) => {
      const resolved = skillsScope(profiles, String(api.conversationId));
      if ("refused" in resolved) {
        return {
          output: [{ type: "text" as const, text: resolved.refused }],
          isError: true as const,
        };
      }
      const { owner, profileId } = resolved.scope;
      const deleted = await skills.remove(owner, profileId, args.name);
      if (!deleted) return text(`no skill named "${args.name}"`, true);
      return {
        ...text(`skill "${args.name}" deleted`),
        structuredOutput: { name: args.name, deleted: true },
      };
    },
  });

const proposeTool = (skills: SkillsService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "skill_propose",
    description:
      "Park a skill improvement for your owner's decision instead of applying it: the move " +
      "for automatic evolution and for any change you are not certain of. The current " +
      "version stays live until your owner accepts. Use skill_write when your owner asked " +
      "for the change directly.",
    parameters: Type.Object({
      skill: Type.String({ description: "The skill's name." }),
      body: Type.String({
        description: `The proposed full SKILL.md text (same rules as skill_write), up to ${MAX_SKILL_CHARS} chars.`,
      }),
      note: Type.String({ description: "One line: what changed and why." }),
    }),
    structuredOutputSchema: Type.Object({ id: Type.String(), skill: Type.String() }),
    execute: async (args, api) => {
      const resolved = skillsScope(profiles, String(api.conversationId));
      if ("refused" in resolved) {
        return {
          output: [{ type: "text" as const, text: resolved.refused }],
          isError: true as const,
        };
      }
      const { owner, profileId } = resolved.scope;
      const proposal = await skills.propose(owner, profileId, {
        skill: args.skill,
        body: args.body,
        note: args.note,
        byProfile: profileId,
      });
      return {
        ...text(
          `proposal ${proposal.id} parked for "${args.skill}"; your owner decides in the ` +
            "Skills page. Keep the current version live until then.",
        ),
        structuredOutput: { id: proposal.id, skill: args.skill },
      };
    },
  });

const text = (value: string, isError = false) =>
  isError
    ? { output: [{ type: "text" as const, text: value }], isError: true as const }
    : { output: [{ type: "text" as const, text: value }] };

/** The core skill tools, in registry order. */
export const skillTools = (skills: SkillsService, profiles: ProfilesService): readonly Tool[] => [
  listTool(skills, profiles),
  loadTool(skills, profiles),
  fileTool(skills, profiles),
  writeTool(skills, profiles),
  deleteTool(skills, profiles),
  proposeTool(skills, profiles),
];
