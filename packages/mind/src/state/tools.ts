/**
 * Durable state as native tools: the entity's own key-value store, scoped to
 * its profile, surviving sessions and restarts. This is where dedup ledgers,
 * generation tokens and "already acted" markers belong — NOT in a session
 * workspace. Reads never grant permission: a missing key is also consistent
 * with a wiped store, so anything whose absence must be distinguishable gets
 * an explicit generation marker written at first action.
 */
import { Type } from "typebox";
import { defineTool, type Tool } from "@spreissen/ext";
import type { KvService } from "./kv.ts";
import type { ProfilesService } from "../profiles/profiles.ts";

const keyParam = Type.String({
  description:
    'Stable key, e.g. "invoice-<id>/acted" or "ledger/generation". Use structured names.',
});

const getTool = (kv: KvService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "state_get",
    description:
      'Read YOUR durable state (survives sessions and restarts). "unset" means no value — ' +
      "which is NOT proof you never acted; write generation markers for anything where that matters.",
    parameters: Type.Object({ key: keyParam }),
    structuredOutputSchema: Type.Object({
      found: Type.Boolean(),
      value: Type.Union([Type.String(), Type.Null()]),
      updatedAt: Type.Union([Type.Number(), Type.Null()]),
    }),
    execute: async (args, api) => {
      const scope = profiles.scopeOf(String(api.conversationId));
      if (scope === undefined) {
        return {
          output: [
            { type: "text" as const, text: "refused: this conversation belongs to no profile." },
          ],
          structuredOutput: { found: false, value: null, updatedAt: null },
        };
      }
      const entry = (await kv.list(scope.profileId)).find((row) => row.key === args.key);
      return {
        output: [
          {
            type: "text" as const,
            text: entry === undefined ? `${args.key}: unset` : `${args.key}: ${entry.value}`,
          },
        ],
        structuredOutput: {
          found: entry !== undefined,
          value: entry?.value ?? null,
          updatedAt: entry?.updatedAt ?? null,
        },
      };
    },
  });

const setTool = (kv: KvService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "state_set",
    description:
      "Write YOUR durable state — dedup ledgers, generation tokens, cross-wake bookmarks. " +
      "Write it BEFORE acting on anything you must not do twice.",
    parameters: Type.Object({ key: keyParam, value: Type.String() }),
    structuredOutputSchema: Type.Object({ ok: Type.Boolean() }),
    execute: async (args, api) => {
      const scope = profiles.scopeOf(String(api.conversationId));
      if (scope === undefined) {
        return {
          output: [
            { type: "text" as const, text: "refused: this conversation belongs to no profile." },
          ],
          isError: true as const,
          structuredOutput: { ok: false },
        };
      }
      if (args.value.length > 8_000) {
        return {
          output: [{ type: "text" as const, text: "refused: value over 8KB — store a pointer." }],
          isError: true as const,
          structuredOutput: { ok: false },
        };
      }
      await kv.set(scope.profileId, args.key, args.value);
      return {
        output: [{ type: "text" as const, text: `stored ${args.key}` }],
        structuredOutput: { ok: true },
      };
    },
  });

const deleteTool = (kv: KvService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "state_delete",
    description: "Remove one of YOUR state keys.",
    parameters: Type.Object({ key: keyParam }),
    structuredOutputSchema: Type.Object({ removed: Type.Boolean() }),
    execute: async (args, api) => {
      const scope = profiles.scopeOf(String(api.conversationId));
      if (scope === undefined) {
        return {
          output: [
            { type: "text" as const, text: "refused: this conversation belongs to no profile." },
          ],
          isError: true as const,
          structuredOutput: { removed: false },
        };
      }
      const removed = await kv.delete(scope.profileId, args.key);
      return {
        output: [{ type: "text" as const, text: removed ? `removed ${args.key}` : "not found" }],
        structuredOutput: { removed },
      };
    },
  });

const listTool = (kv: KvService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "state_list",
    description: "List YOUR durable state keys (keys + timestamps, not values).",
    parameters: Type.Object({}),
    structuredOutputSchema: Type.Array(
      Type.Object({ key: Type.String(), updatedAt: Type.Number() }),
    ),
    execute: async (_args, api) => {
      const scope = profiles.scopeOf(String(api.conversationId));
      if (scope === undefined) {
        return {
          output: [
            { type: "text" as const, text: "refused: this conversation belongs to no profile." },
          ],
          structuredOutput: [],
        };
      }
      const rows = await kv.list(scope.profileId);
      return {
        output: [
          {
            type: "text" as const,
            text:
              rows.length === 0
                ? "no state"
                : rows.map((r) => `${r.key} @ ${r.updatedAt}`).join("\n"),
          },
        ],
        structuredOutput: rows.map((r) => ({ key: r.key, updatedAt: r.updatedAt })),
      };
    },
  });

/** The state tools in registry order. */
export const stateTools = (kv: KvService, profiles: ProfilesService): readonly Tool[] => [
  getTool(kv, profiles),
  setTool(kv, profiles),
  deleteTool(kv, profiles),
  listTool(kv, profiles),
];
