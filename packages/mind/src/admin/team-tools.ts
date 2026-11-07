/**
 * The main bot's team tools: `teams_list` (every home with its
 * bots), `team_create`, `team_update` (rename, Instructions, VM
 * size) and `team_delete`. Main bot only (see common.ts); updates and
 * deletes park an owner card first, since every bot in the team
 * follows its Instructions. Creation runs without a card when the MAIN bot
 * acts (ownerUnlessMain — assembling crew is its job); any other
 * may-administer actor gets the card. A delete warns first: a team
 * that still has bots is refused with their names and the way out (move
 * them to the org with bot_move, or export them on the team page).
 * Host-access switches are never read from the model.
 */
import { Duration } from "effect";
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { TeamInfo, ProfileInfo } from "@spriessen/contracts";
import { defineTool } from "@spriessen/ext";
import { withApproval } from "../approvals.ts";
import { withAudit } from "../audit/audit.ts";
import { textReply } from "../act/task-live.ts";
import {
  adminGuard,
  adminOf,
  auditChange,
  failed,
  orgOf,
  resolveTeam,
  vmOf,
  type AdminDeps,
} from "./common.ts";

export const TEAMS_LIST = "teams_list";
export const TEAM_CREATE = "team_create";
export const TEAM_UPDATE = "team_update";
export const TEAM_DELETE = "team_delete";

const vmWords = (vm: TeamInfo["vm"]): string => `${vm.cpus} CPU · ${vm.memoryMiB} MiB`;

const firstLine = (text: string): string => {
  const line = text.split(/\r?\n/).find((entry) => entry.trim() !== "") ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

const botWords = (bots: readonly ProfileInfo[], mainId: string | null): string =>
  bots.length === 0
    ? "no bots"
    : bots
        .map(
          (bot) =>
            `${bot.name}${bot.id === mainId ? " (main)" : ""}${bot.archivedAt !== null ? " (paused)" : ""}`,
        )
        .join(", ");

/** The whole org as lines: the org's own bots, then each team with its bots. */
export const homesText = (
  orgName: string,
  teams: readonly TeamInfo[],
  bots: readonly ProfileInfo[],
  mainId: string | null,
): string => {
  const known = new Set(teams.map((row) => row.id));
  const orgBots = bots.filter((bot) => !known.has(bot.teamId ?? ""));
  const lines = [`The org "${orgName}": ${botWords(orgBots, mainId)}`];
  for (const team of teams) {
    const own = bots.filter((bot) => bot.teamId === team.id);
    const said = firstLine(team.instructions);
    lines.push(
      `Team "${team.name}" (id ${team.id}; VM ${vmWords(team.vm)}; ` +
        `host access ${team.hostAccess ? "on" : "off"}; ` +
        `Instructions: ${said === "" ? "none" : `"${said}"`}): ${botWords(own, mainId)}`,
    );
  }
  return lines.join("\n");
};

const listTool = (deps: AdminDeps) =>
  defineTool({
    name: TEAMS_LIST,
    description:
      "List the org's homes: the org itself and every team, each with its bots, VM size, " +
      "host-access state and first line of Instructions. Main bot only. Use it before " +
      "creating, moving or deleting so you name the right team.",
    // Read-only, so script-callable: main-bot-only stays in execute (adminOf).
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api) => {
      const me = await adminOf(deps, String(api.conversationId));
      if (typeof me === "string") return failed("listed", me);
      const view = await orgOf(deps).view();
      const bots = await deps.profiles.list(me.owner);
      const mainId = await deps.profiles.mainOf(me.owner);
      return textReply(homesText(view.org?.name ?? "Personal", view.teams, bots, mainId));
    },
  });

const createTool = (deps: AdminDeps) =>
  defineTool({
    name: TEAM_CREATE,
    description:
      "Create a team: a home for bots with its own Instructions (every bot in it follows " +
      "them, before its own) and VM size. Main bot only. Host access starts off; only the " +
      "owner can turn it on. Then move or create bots into it.",
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 80, description: "The team's name." }),
      instructions: Type.Optional(
        Type.String({ maxLength: 16_000, description: "Standing Instructions for its bots." }),
      ),
      cpus: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 64, description: "VM CPUs (default 1)." }),
      ),
      memoryMiB: Type.Optional(
        Type.Integer({
          minimum: 128,
          maximum: 65_536,
          description: "VM memory in MiB (default 512).",
        }),
      ),
    }),
    callers: ["model"],
    execute: async (args, api) => {
      const me = await adminOf(deps, String(api.conversationId));
      if (typeof me === "string") return failed("created", me);
      try {
        const name = args.name.trim();
        if (name === "") return failed("created", "the name is empty");
        const vm = vmOf(args.cpus, args.memoryMiB, { cpus: 1, memoryMiB: 512 });
        const team = await orgOf(deps).createTeam(
          {
            name,
            hostAccess: false,
            ...(vm !== undefined ? { vm } : {}),
            ...(args.instructions !== undefined ? { instructions: args.instructions.trim() } : {}),
          },
          me.owner,
        );
        auditChange(deps, me.id, "team-created");
        return textReply(
          `created team "${team.name}" (id ${team.id}; VM ${vmWords(team.vm)}; host access off). ` +
            "It is empty: move bots in with bot_move or create one there with bot_create.",
        );
      } catch (cause) {
        return failed("created", cause);
      }
    },
  });

const updateTool = (deps: AdminDeps) =>
  defineTool({
    name: TEAM_UPDATE,
    description:
      "Change a team: rename it, replace its Instructions, or resize its VM. Main bot " +
      "only; the owner confirms on a card. Give only the fields to change. Instructions " +
      "replace the old text entirely, so include what should stay. Host access is the owner's.",
    parameters: Type.Object({
      team: Type.String({ description: "The team's name or id." }),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "A new name." })),
      instructions: Type.Optional(
        Type.String({ maxLength: 16_000, description: "The full new Instructions text." }),
      ),
      cpus: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
      memoryMiB: Type.Optional(Type.Integer({ minimum: 128, maximum: 65_536 })),
    }),
    callers: ["model"],
    execute: async (args, api) => {
      const me = await adminOf(deps, String(api.conversationId));
      if (typeof me === "string") return failed("changed", me);
      try {
        const team = await resolveTeam(deps, args.team);
        const vm = vmOf(args.cpus, args.memoryMiB, team.vm);
        const name = args.name?.trim();
        if (name === "") return failed("changed", "the new name is empty");
        const next = await orgOf(deps).updateTeam(team.id, {
          ...(name !== undefined ? { name } : {}),
          ...(args.instructions !== undefined ? { instructions: args.instructions } : {}),
          ...(vm !== undefined ? { vm } : {}),
        });
        auditChange(deps, me.id, "team-updated");
        return textReply(
          `updated team "${next.name}" (VM ${vmWords(next.vm)}). ` +
            "Its bots follow the new Instructions from their next turn.",
        );
      } catch (cause) {
        return failed("changed", cause);
      }
    },
  });

/** The warn-first check: a team with bots is refused with their names and the way out. */
export const deleteProblem = async (deps: AdminDeps, owner: string, ref: string) => {
  const team = await resolveTeam(deps, ref);
  const bots = (await deps.profiles.list(owner)).filter((bot) => bot.teamId === team.id);
  if (bots.length === 0) return { team, problem: undefined };
  return {
    team,
    problem:
      `team "${team.name}" still has ${bots.length} bot(s): ${bots.map((bot) => bot.name).join(", ")}. ` +
      'Move each to the org first (bot_move with to "org"), or ask the owner to export them ' +
      "from the team page before deleting them",
  };
};

const deleteTool = (deps: AdminDeps) =>
  defineTool({
    name: TEAM_DELETE,
    description:
      "Delete an empty team. Main bot only; the owner confirms on a card. A team " +
      "that still has bots is refused with their names: move them to the org with bot_move " +
      "first (nothing is deleted with it but its Instructions, members and grants).",
    parameters: Type.Object({
      team: Type.String({ description: "The team's name or id." }),
    }),
    callers: ["model"],
    execute: async (args, api) => {
      const me = await adminOf(deps, String(api.conversationId));
      if (typeof me === "string") return failed("deleted", me);
      try {
        const { team, problem } = await deleteProblem(deps, me.owner, args.team);
        if (problem !== undefined) return failed("deleted", problem);
        await orgOf(deps).removeTeam(team.id);
        auditChange(deps, me.id, "team-removed");
        return textReply(`deleted team "${team.name}".`);
      } catch (cause) {
        return failed("deleted", cause);
      }
    },
  });

/** Refused before the card: not the main bot, an unknown team, or one with bots. */
const deleteGuard = (deps: AdminDeps) => async (args: unknown, api: unknown) => {
  const refused = await adminGuard(deps)(args, api);
  if (refused !== undefined) return refused;
  const me = deps.profiles.profileOf(String((api as { conversationId: unknown }).conversationId));
  try {
    const ref = String((args as { team?: unknown }).team ?? "");
    const { problem } = await deleteProblem(deps, me?.owner ?? "", ref);
    return problem === undefined ? undefined : `not deleted: ${problem}`;
  } catch (cause) {
    return `not deleted: ${(cause as { reason?: string }).reason ?? String(cause)}`;
  }
};

export const teamTools = (deps: AdminDeps): readonly ToolRegistration[] => {
  const profileOf = (conversationId: string): string | null =>
    deps.profiles.profileOf(conversationId)?.id ?? null;
  const card = { owner: true, timeout: Duration.minutes(10) } as const;
  return [
    withAudit(deps.audit, listTool(deps), profileOf),
    withAudit(
      deps.audit,
      withApproval(deps.approvals, createTool(deps), {
        ownerUnlessMain: true,
        editable: true,
        guard: adminGuard(deps),
        timeout: Duration.minutes(10),
      }),
      profileOf,
    ),
    withAudit(
      deps.audit,
      withApproval(deps.approvals, updateTool(deps), { ...card, guard: adminGuard(deps) }),
      profileOf,
    ),
    withAudit(
      deps.audit,
      withApproval(deps.approvals, deleteTool(deps), { ...card, guard: deleteGuard(deps) }),
      profileOf,
    ),
  ];
};
