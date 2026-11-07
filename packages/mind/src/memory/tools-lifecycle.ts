/**
 * `memory_forget` and `memory_history`: the lifecycle tools. Forget makes a
 * restorable tombstone (nothing is deleted — Purge is the owner's separate,
 * irreversible act). History shows one fact's version chain: validity,
 * change type and source for every version.
 */
import { Type } from "typebox";
import { defineTool, type Tool } from "@spriessen/ext";
import type { MemoryService } from "./memory.ts";
import { causeText, dayOf, handleOf } from "./handles.ts";
import { evidenceLine } from "./evidence.ts";
import type { ProfilesService } from "../profiles/profiles.ts";

const refusal = (reason: string) => ({
  output: [{ type: "text" as const, text: reason }],
  isError: true as const,
});

export const forgetTool = (memory: MemoryService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "memory_forget",
    description:
      "Retract one of your facts by id: it becomes a restorable tombstone, hidden from recall " +
      "but kept for history until the owner purges. Use when a fact is wrong or no longer " +
      "yours to claim; when it was wrong and you know the right version, use memory_update (correct) instead. Your " +
      "own facts only; owner-stated facts can be forgotten only when the owner asked in this " +
      "turn. Always give the reason.",
    parameters: Type.Object({
      id: Type.String({
        description: "The fact's #handle (from memory_recall or memory_history).",
      }),
      reason: Type.String({ description: "Why this fact is being retracted." }),
    }),
    structuredOutputSchema: Type.Object({ id: Type.String(), forgotten: Type.Boolean() }),
    execute: (args, api) => {
      const scope = profiles.scopeOf(String(api.conversationId));
      if (scope === undefined) {
        return Promise.resolve(refusal("refused: this conversation belongs to no profile."));
      }
      return memory
        .forget(scope.owner, scope.profileId, args.id, args.reason, String(api.conversationId))
        .then((result) => ({
          output: [
            {
              type: "text" as const,
              text: `forgotten ${result.id.slice(0, 8)}… (restorable tombstone; the owner can restore or purge).`,
            },
          ],
          structuredOutput: { id: result.id, forgotten: true },
        }))
        .catch((cause: unknown) => refusal(`refused: ${causeText(cause)}`));
    },
  });

export const historyTool = (memory: MemoryService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "memory_history",
    description:
      "Show one fact's version chain: every version with its validity window, what changed " +
      "(created, refined, superseded, corrected, ended, forgotten) and its evidence: who it came " +
      "from, the day and chat it was learned in, and the note it was saved from. Use it before " +
      "relying on a fact for something consequential or historical (the note is the evidence; " +
      "history_search on that day finds the conversation), or to find the #handle for " +
      "memory_update. History stays until the owner purges, so forgetting is reversible.",
    parameters: Type.Object({
      id: Type.String({ description: "The fact's #handle to trace." }),
    }),
    structuredOutputSchema: Type.Array(
      Type.Object({
        id: Type.String(),
        text: Type.String(),
        status: Type.String(),
        change: Type.String(),
        validFrom: Type.Union([Type.Number(), Type.Null()]),
        validTo: Type.Union([Type.Number(), Type.Null()]),
        supersededBy: Type.Union([Type.String(), Type.Null()]),
      }),
    ),
    execute: (args, api) => {
      const scope = profiles.scopeOf(String(api.conversationId));
      if (scope === undefined) {
        return Promise.resolve(refusal("refused: this conversation belongs to no profile."));
      }
      return memory
        .history(scope.owner, scope.profileId, args.id)
        .then((chain) => ({
          output: [
            {
              type: "text" as const,
              text: chain
                .map(
                  (entry) =>
                    `${handleOf(entry.id)} ${entry.text} [${entry.status}, ${entry.change}, ` +
                    `from ${entry.validFrom === null ? "?" : dayOf(entry.validFrom)} ` +
                    `to ${entry.validTo === null ? "now" : dayOf(entry.validTo)}]\n  ` +
                    evidenceLine({
                      source: entry.source,
                      learnedAt: entry.learnedAt,
                      chat:
                        entry.source.conversation === null
                          ? null
                          : (profiles.scopeOf(entry.source.conversation)?.kind ?? null),
                      note: entry.note,
                    }),
                )
                .join("\n"),
            },
          ],
          structuredOutput: chain.map((entry) => ({
            id: entry.id,
            text: entry.text,
            status: entry.status,
            change: entry.change,
            validFrom: entry.validFrom,
            validTo: entry.validTo,
            supersededBy: entry.supersededBy,
          })),
        }))
        .catch((cause: unknown) => refusal(`refused: ${causeText(cause)}`));
    },
  });

/**
 * `memory_related`: the entity card — who/what this is, its current facts and
 * its graph neighbours (the triples on facts ARE the edges).
 */
export const relatedTool = (memory: MemoryService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "memory_related",
    description:
      "Open an entity's card: a person, pet, place or project your memory knows: its current " +
      "facts and its neighbours (connected through facts like lives_in or has_pet, 1 hop by " +
      "default, 2 with depth). Use it before answering questions about someone or something " +
      "specific, and to see how two things connect. Names match by id, name or alias in " +
      "either language.",
    parameters: Type.Object({
      entity: Type.String({ description: "Entity id, name or alias." }),
      depth: Type.Optional(Type.Number({ description: "1 (default) or 2 hops." })),
    }),
    structuredOutputSchema: Type.Object({
      entity: Type.String(),
      type: Type.String(),
      facts: Type.Array(Type.Object({ id: Type.String(), text: Type.String() })),
      neighbours: Type.Array(Type.Object({ name: Type.String(), via: Type.String() })),
    }),
    execute: (args, api) => {
      const scope = profiles.scopeOf(String(api.conversationId));
      if (scope === undefined) {
        return Promise.resolve(refusal("refused: this conversation belongs to no profile."));
      }
      const depth = args.depth === 2 ? 2 : 1;
      return memory
        .related(scope.owner, scope.profileId, args.entity, depth)
        .then((card) => ({
          output: [
            {
              type: "text" as const,
              text:
                `${card.entity.name} (${card.entity.type})\n` +
                card.facts.map((fact) => `- ${handleOf(fact.id)} ${fact.text}`).join("\n") +
                (card.neighbours.length > 0
                  ? `\nConnected: ${card.neighbours.map((n) => `${n.entity.name} (${n.via})`).join(", ")}`
                  : ""),
            },
          ],
          structuredOutput: {
            entity: card.entity.name,
            type: card.entity.type,
            facts: card.facts.map(({ id, text }) => ({ id, text })),
            neighbours: card.neighbours.map(({ entity, via }) => ({ name: entity.name, via })),
          },
        }))
        .catch((cause: unknown) => refusal(`refused: ${causeText(cause)}`));
    },
  });
