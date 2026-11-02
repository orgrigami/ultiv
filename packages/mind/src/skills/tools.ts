/**
 * The skill tools as native parts of the agent loop: list, load, read a
 * reference file, write (create or update), delete (gated), and propose
 * (park a change for the owner). A write on the owner's own turn is ungated,
 * but runs skill_learn's checks first (the `writeGuard` the skills extension
 * passes in, learn.ts `skillWriteGuard`): outside or approval text is
 * refused, and learning off or a turn the owner didn't start asks the owner.
 * Deletes are gated like artifact deletes.
 * skill_install and skill_evolve live beside this file.
 */
import { Type } from "typebox";
import { defineTool, type Tool } from "@spriessen/ext";
import type { ProfilesService } from "../profiles/profiles.ts";
import type { ConversationScope } from "../profiles/docs.ts";
import { MAX_SKILL_OPS, type SkillOp } from "./batch.ts";
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

/** Reference files riding along a write: the skill's COMPLETE set. */
const FilesSchema = Type.Array(
  Type.Object({
    path: Type.String({
      description:
        "Path relative to the skill folder: references/, scripts/, assets/, or any layout.",
    }),
    content: Type.String({ description: "The file's UTF-8 text content." }),
  }),
  {
    description:
      "The skill's COMPLETE reference set (references, templates, scripts): these are " +
      "written and extras on disk are pruned. Omit to leave current files untouched; " +
      "pass [] to remove all. Text only, no secrets.",
  },
);

const WriteParams = Type.Object({
  name: Type.String({
    description: "The skill's name: lowercase-and-hyphens, at most 64 chars (create or update).",
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
  files: Type.Optional(FilesSchema),
});

/** Refusal text, or undefined to go ahead (it may wait on the owner first). */
export type SkillWriteGuard = (
  input: {
    readonly name: string;
    readonly body: string;
    readonly files?: readonly { readonly path: string; readonly content: string }[] | undefined;
  },
  api: { readonly conversationId: unknown; readonly callId: unknown },
) => Promise<string | undefined>;

/** Options the skills extension passes its core tools. */
export interface SkillToolOptions {
  readonly writeGuard?: SkillWriteGuard | undefined;
  /**
   * skill_edit's per-turn save cap, wired from the shared learning gate:
   * returns a refusal when a batch of `ops` exceeds what this turn still
   * has left (each op is one save). Absent in bare test rigs.
   */
  readonly batchAllowance?:
    | ((ops: number, conversationId: string) => Promise<string | undefined>)
    | undefined;
}

const writeTool = (
  skills: SkillsService,
  profiles: ProfilesService,
  guard: SkillWriteGuard | undefined,
): Tool =>
  defineTool({
    name: "skill_write",
    description:
      "Write a skill: a procedure of yours worth keeping (done twice, or your owner said " +
      '"do it this way from now on"). Creates or updates it in YOUR namespace; it joins your ' +
      "skill list next turn. Reference files (templates, scripts, docs) ride along: pass " +
      "`files` as the complete set and read them back with skill_file. Never put secrets in " +
      "skill text. Updating keeps the previous version, so an edit is reversible.",
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
      const refused = await guard?.({ name: args.name, body, files: args.files }, api);
      if (refused !== undefined) return text(refused, true);
      const existing = await skills.read(owner, profileId, args.name);
      const meta = await skills.write(owner, profileId, {
        name: args.name,
        body,
        ...(args.files !== undefined ? { files: args.files } : {}),
        by: "bot",
        turn: `${String(api.conversationId)}#${String(api.callId)}`,
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

/** The bot-facing batch tool: creates and updates only, all-or-nothing. */
export const SKILL_EDIT = "skill_edit";

const EditParams = Type.Object({
  ops: Type.Array(
    Type.Object({
      op: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("remove")]),
      name: Type.String({
        description: "The skill's name: lowercase-and-hyphens, at most 64 chars.",
      }),
      body: Type.Optional(
        Type.String({
          description: `The full SKILL.md text (frontmatter required), up to ${MAX_SKILL_CHARS} chars; required for create and update.`,
        }),
      ),
      files: Type.Optional(FilesSchema),
    }),
    {
      description: `The changes, in order: at most ${MAX_SKILL_OPS} ops, each naming a different skill.`,
    },
  ),
});

const editTool = (
  skills: SkillsService,
  profiles: ProfilesService,
  options: SkillToolOptions,
): Tool =>
  defineTool({
    name: SKILL_EDIT,
    description:
      "Apply several skill changes in ONE all-or-nothing batch (create and/or update): " +
      "every op is checked first, and if any op is refused NOTHING is saved — your skills " +
      "stay exactly as they were. Each op counts toward your per-turn save cap. Same rules " +
      "per op as skill_write: the body replaces the skill's whole text, `files` is the " +
      "complete reference set, never secrets. Removing a skill is not a batch op: use " +
      "skill_delete for that.",
    parameters: EditParams,
    structuredOutputSchema: Type.Array(
      Type.Object({
        op: Type.String(),
        name: Type.String(),
        version: Type.Optional(Type.Number()),
        removed: Type.Optional(Type.Boolean()),
      }),
    ),
    execute: async (args, api) => {
      const resolved = skillsScope(profiles, String(api.conversationId));
      if ("refused" in resolved) return text(resolved.refused, true);
      const { owner, profileId } = resolved.scope;
      const ops: SkillOp[] = [];
      for (const [index, item] of (args.ops ?? []).entries()) {
        if (item.op === "remove") {
          return text(
            `op ${index + 1} is a remove: skill_edit never deletes — use skill_delete ` +
              "(your owner approves deletions)",
            true,
          );
        }
        if (item.body === undefined) {
          return text(`op ${index + 1} (${item.op} "${item.name}") needs a body`, true);
        }
        ops.push({
          op: item.op,
          name: item.name,
          body: item.body,
          ...(item.files !== undefined ? { files: item.files } : {}),
        });
      }
      const allowance = await options.batchAllowance?.(ops.length, String(api.conversationId));
      if (allowance !== undefined) return text(allowance, true);
      const guard = options.writeGuard;
      try {
        const outcomes = await skills.applyOps(owner, profileId, ops, {
          by: "bot",
          turn: `${String(api.conversationId)}#${String(api.callId)}`,
          ...(guard !== undefined ? { gate: async (input) => guard(input, api) } : {}),
        });
        const line = outcomes
          .map((outcome) =>
            outcome.removed === true
              ? `removed "${outcome.name}"`
              : `${outcome.op} "${outcome.name}" (v${outcome.version})`,
          )
          .join(", ");
        return { ...text(`batch applied: ${line}`), structuredOutput: outcomes };
      } catch (cause) {
        return text(cause instanceof Error ? cause.message : String(cause), true);
      }
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
export const skillTools = (
  skills: SkillsService,
  profiles: ProfilesService,
  options: SkillToolOptions = {},
): readonly Tool[] => [
  listTool(skills, profiles),
  loadTool(skills, profiles),
  fileTool(skills, profiles),
  writeTool(skills, profiles, options.writeGuard),
  editTool(skills, profiles, options),
  deleteTool(skills, profiles),
  proposeTool(skills, profiles),
];
