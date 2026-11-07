/**
 * Memory as native tools: `memory_write` (authority-checked) and
 * `memory_recall`. Entities remember for themselves; the designated keeper
 * may also distill into the owner store. Recall reads own + owner memory —
 * never a sibling's.
 */
import { Type } from "typebox";
import { defineTool, type Tool } from "@spriessen/ext";
import type { AuditService } from "../audit/audit.ts";
import type { ConverseService } from "../converse/converse.ts";
import type { MemoryService } from "./memory.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { CORE_LIMITS } from "./core.ts";
import { teamKey } from "./model.ts";
import { forgetTool, historyTool, relatedTool } from "./tools-lifecycle.ts";
import { contextOf, coreVerdict } from "./guard.ts";

import { writeTool } from "./tools-write.ts";
import { parseWhen } from "./dates.ts";
import { causeText } from "./handles.ts";
import { updateTool } from "./tools-update.ts";

const recallTool = (
  memory: MemoryService,
  profiles: ProfilesService,
  /** The bot's team id, for the shared store in the pool (slice 9). */
  teamOf?: (profileId: string) => Promise<string | null>,
): Tool =>
  defineTool({
    name: "memory_recall",
    description:
      "Search durable memory: your facts plus the owner-level store. Ranked and bilingual: " +
      "Indonesian queries find English facts and vice versa. Use before re-asking anything " +
      "you may already know; call with no query for the top facts. `about` narrows to an " +
      'entity; history (superseded facts) needs includeHistory or words like "dulu" or ' +
      '"used to". Results are current facts first, budgeted; do not dump them into chat ' +
      "verbatim; treat unverified lines with suspicion.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Free text, either language; empty returns the top facts." }),
      ),
      about: Type.Optional(
        Type.String({ description: "An entity, person or project the query is about." }),
      ),
      includeHistory: Type.Optional(
        Type.Boolean({ description: "Include superseded facts, grouped under their successor." }),
      ),
      asOf: Type.Optional(
        Type.String({
          description: "What held on that day (YYYY-MM-DD): the versions valid then, not now.",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max facts, 1–25 (default 10)." })),
      budgetTokens: Type.Optional(
        Type.Number({ description: "Output budget in tokens; default 600, max 1500." }),
      ),
    }),
    structuredOutputSchema: Type.Array(
      Type.Object({
        id: Type.String(),
        text: Type.String(),
        tags: Type.Array(Type.String()),
        status: Type.String(),
        scope: Type.String(),
      }),
    ),
    execute: async (args, api) => {
      const scope = profiles.scopeOf(String(api.conversationId));
      if (scope === undefined) {
        return {
          output: [
            { type: "text" as const, text: "no memory: this conversation belongs to no profile." },
          ],
          structuredOutput: [],
        };
      }
      const query = [args.about, args.query].filter((part) => part !== undefined).join(" ");
      let asOf: number | undefined;
      try {
        // The END of that day: "on 2026-03-01" includes what started that day.
        const day = parseWhen(args.asOf);
        asOf = day === undefined ? undefined : day + 86_399_999;
      } catch (cause) {
        return {
          output: [{ type: "text" as const, text: causeText(cause) }],
          structuredOutput: [],
        };
      }
      // A team bot recalls its team's accepted shared facts too.
      const teamId = teamOf === undefined ? null : await teamOf(scope.profileId);
      return memory
        .recallV2(scope.owner, scope.profileId, {
          ...(query !== "" ? { query } : {}),
          ...(args.includeHistory !== undefined ? { includeHistory: args.includeHistory } : {}),
          ...(asOf !== undefined ? { asOf } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.budgetTokens !== undefined ? { budgetTokens: args.budgetTokens } : {}),
          ...(teamId !== null ? { extraStores: [teamKey(scope.owner, teamId)] } : {}),
        })
        .then((result) => ({
          output: [
            {
              type: "text" as const,
              text: result.lines.length === 0 ? "no matching memory." : result.lines.join("\n"),
            },
          ],
          structuredOutput: result.facts.map((fact) => ({
            id: fact.id,
            text: fact.text,
            tags: fact.tags,
            status: fact.status,
            scope: fact.scope,
          })),
        }));
    },
  });

/** The memory tools in registry order. */
export const memoryTools = (
  memory: MemoryService,
  profiles: ProfilesService,
  guardDeps: {
    readonly converse: ConverseService;
    readonly audit?: AuditService;
    readonly untrustedTool?: (name: string) => boolean;
    readonly teamOf?: (profileId: string) => Promise<string | null>;
  },
): readonly Tool[] => [
  writeTool(memory, profiles, guardDeps),
  updateTool(memory, profiles, guardDeps),
  recallTool(memory, profiles, guardDeps.teamOf),
  coreTool(memory, profiles, guardDeps),
  forgetTool(memory, profiles),
  historyTool(memory, profiles),
  relatedTool(memory, profiles),
];

const refuseOf = (reason: string) => ({
  output: [{ type: "text" as const, text: reason }],
  isError: true as const,
});

/**
 * `memory_core`: add / replace / remove a line in the always-on block. Owner
 * scope is keeper-only; pinned lines are owner-only; the reply carries the
 * words remaining so the model can self-budget. Writes ride the guard: only
 * clean owner-voiced turns may edit core (the block renders in EVERY prompt,
 * so it is a lasting injection path).
 */
const coreTool = (
  memory: MemoryService,
  profiles: ProfilesService,
  guardDeps: {
    readonly converse: ConverseService;
    readonly audit?: AuditService;
    readonly untrustedTool?: (name: string) => boolean;
  },
): Tool =>
  defineTool({
    name: "memory_core",
    description:
      "Edit your core memory: the few lines that sit in EVERY one of your prompts (the owner " +
      "store is the designated keeper's). Keep it small: identity, language, time zone, key " +
      'preferences. One fact per line, at most 25 words. Add with action "add"; replace or ' +
      "remove by line id. Lines the owner pinned are yours to read, never to edit. Use " +
      "sparingly: this block is always in context, so every word is a permanent cost.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("add"),
          Type.Literal("replace"),
          Type.Literal("remove"),
          Type.Literal("list"),
        ],
        { description: 'What to do; "list" shows the current lines.' },
      ),
      text: Type.Optional(Type.String({ description: "The line's text (add/replace)." })),
      lineId: Type.Optional(Type.String({ description: "The line id (replace/remove)." })),
      scope: Type.Optional(
        Type.Union([Type.Literal("profile"), Type.Literal("owner")], {
          description: '"profile" (default): your own core. "owner": keeper only.',
        }),
      ),
    }),
    structuredOutputSchema: Type.Object({
      lines: Type.Array(
        Type.Object({ id: Type.String(), text: Type.String(), pinned: Type.Boolean() }),
      ),
      wordsLeft: Type.Number(),
    }),
    execute: (args, api) => {
      const scope = profiles.scopeOf(String(api.conversationId));
      if (scope === undefined) {
        return Promise.resolve(refuseOf("refused: this conversation belongs to no profile."));
      }
      const target = args.scope ?? "profile";
      const run = async () => {
        const profileId = target === "owner" ? null : scope.profileId;
        if (args.action !== "list") {
          // Guard: origin, taint and secrets. Without an audit the guard
          // can't read the turn (tests); the write then keeps tool defaults.
          if (guardDeps.audit !== undefined) {
            const context = await contextOf(guardDeps, String(api.conversationId));
            const verdict = coreVerdict(context, args.text ?? "");
            if (!verdict.ok) return refuseOf(verdict.reason ?? "refused");
          }
        }
        if (args.action === "list") {
          const lines = await memory.core.read(scope.owner, profileId);
          return {
            output: [
              {
                type: "text" as const,
                text:
                  lines.length === 0
                    ? "core memory is empty."
                    : lines.map((l) => `- ${l.text}`).join("\n"),
              },
            ],
            structuredOutput: {
              lines: lines.map(({ id, text, pinned }) => ({ id, text, pinned })),
              wordsLeft: 0,
            },
          };
        }
        const writer = scope.profileId;
        if (args.action === "add") {
          if (args.text === undefined || args.text.trim() === "") {
            return refuseOf("refused: text is required to add a core line.");
          }
          await memory.core.add({
            owner: scope.owner,
            profileId,
            scope: target,
            writer,
            text: args.text,
          });
        } else if (args.action === "replace") {
          if (args.lineId === undefined || args.text === undefined) {
            return refuseOf("refused: lineId and text are required to replace a core line.");
          }
          await memory.core.replace({
            owner: scope.owner,
            profileId,
            writer,
            lineId: args.lineId,
            text: args.text,
          });
        } else {
          if (args.lineId === undefined) {
            return refuseOf("refused: lineId is required to remove a core line.");
          }
          await memory.core.remove({
            owner: scope.owner,
            profileId,
            writer,
            lineId: args.lineId,
          });
        }
        const lines = await memory.core.read(scope.owner, profileId);
        const words = lines.reduce(
          (sum, line) => sum + line.text.trim().split(/\s+/).filter(Boolean).length,
          0,
        );
        const budget = target === "owner" ? CORE_LIMITS.ownerWords : CORE_LIMITS.profileWords;
        return {
          output: [
            {
              type: "text" as const,
              text: `core updated: ${lines.length} line(s), ${Math.max(0, budget - words)} words left.`,
            },
          ],
          structuredOutput: {
            lines: lines.map(({ id, text, pinned }) => ({ id, text, pinned })),
            wordsLeft: Math.max(0, budget - words),
          },
        };
      };
      return run().catch((cause: unknown) =>
        refuseOf(`refused: ${(cause as { reason?: string }).reason ?? String(cause)}`),
      );
    },
  });
