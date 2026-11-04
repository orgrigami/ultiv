/**
 * The `memory_recall` prompt section: recall before each turn (prefetch.ts)
 * wired into the harness. It renders before every model request, finds the
 * conversation's latest input, and — once per input, cached across the
 * turn's tool rounds — recalls, gates and renders the few memories it is
 * about. Nothing passes: no section. `MEMORY_PREFETCH=off` turns it off.
 */
import { Effect } from "effect";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import type { MemoryFact } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { ATTACHMENTS_MARK } from "../converse/steps.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import type { MemoryService } from "./memory.ts";
import { gateFacts, renderPrefetch, shownLedger } from "./prefetch.ts";
import { indexTerms } from "./text.ts";

export const PREFETCH_SECTION_KEY = "memory_recall";
const SCAN = 30;
const QUERY_CHARS = 1_000;

/** The newest input of a conversation: its entry id and what it said. */
const latestInput = async (
  converse: ConverseService,
  conversationId: string,
): Promise<{ readonly id: string; readonly text: string } | undefined> => {
  const entries = await Effect.runPromise(converse.entriesOf(conversationId, SCAN)).catch(() => []);
  for (const entry of entries) {
    const user = entry.model?.find((message) => message.role === "user");
    if (user === undefined) continue;
    const content = user.content;
    const text =
      typeof content === "string"
        ? content
        : content.map((block) => (block.type === "text" ? block.text : "")).join(" ");
    return { id: String(entry.id), text: (text.split(ATTACHMENTS_MARK)[0] ?? "").trim() };
  }
  return undefined;
};

export const prefetchExtension = (deps: {
  readonly memory: MemoryService;
  readonly profiles: ProfilesService;
  readonly converse: ConverseService;
}): Extension => {
  const ledger = shownLedger();
  const rendered = new Map<string, { input: string; text: string | undefined }>();
  const termCache = new Map<string, ReadonlySet<string>>();
  const termsOf = (fact: MemoryFact): ReadonlySet<string> => {
    const key = `${fact.id}:${fact.hash}`;
    const hit = termCache.get(key);
    if (hit !== undefined) return hit;
    const terms = new Set([
      ...indexTerms(fact.text),
      ...fact.tags.flatMap((tag) => indexTerms(tag)),
    ]);
    if (termCache.size > 20_000) termCache.clear();
    termCache.set(key, terms);
    return terms;
  };

  const compute = async (conversationId: string, input: { id: string; text: string }) => {
    const scope = deps.profiles.scopeOf(conversationId);
    if (scope === undefined || input.text === "") return undefined;
    const [recalled, own, shared, ownEntities, sharedEntities] = await Promise.all([
      deps.memory.recallV2(scope.owner, scope.profileId, {
        query: input.text.slice(0, QUERY_CHARS),
        limit: 12,
      }),
      deps.memory.readFacts(scope.owner, scope.profileId),
      deps.memory.readFacts(scope.owner, null),
      deps.memory.entities(scope.owner, scope.profileId),
      deps.memory.entities(scope.owner, null),
    ]);
    const facts = gateFacts({
      message: input.text,
      candidates: recalled.facts,
      pool: [...own, ...shared].filter((fact) => fact.status === "current"),
      entities: [...ownEntities, ...sharedEntities],
      termsOf,
      exclude: ledger.recent(conversationId, input.id),
    });
    ledger.record(
      conversationId,
      input.id,
      facts.map((fact) => fact.id),
    );
    return renderPrefetch(facts);
  };

  return defineExtension({
    name: "ultiv.memory.prefetch",
    sections: [
      {
        key: PREFETCH_SECTION_KEY,
        render: async (input) => {
          if (process.env.MEMORY_PREFETCH === "off") return undefined;
          const conversationId = String(input.conversationId);
          const latest = await latestInput(deps.converse, conversationId);
          if (latest === undefined) return undefined;
          const cached = rendered.get(conversationId);
          if (cached?.input === latest.id) return cached.text;
          const text = await compute(conversationId, latest).catch((cause: unknown) => {
            console.warn("memory prefetch failed:", String(cause).slice(0, 200));
            return undefined;
          });
          rendered.set(conversationId, { input: latest.id, text });
          if (rendered.size > 2_000) {
            const oldest = rendered.keys().next().value;
            if (oldest !== undefined) rendered.delete(oldest);
          }
          return text;
        },
      },
    ],
  });
};
