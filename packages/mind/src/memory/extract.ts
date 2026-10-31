/**
 * Fact extraction for memory writes: one structured completion that cleans a
 * raw note into a fact — kind, canonical text, entity NAMES, an optional
 * (s, p, o) triple. Prompt-only JSON (never response_format on kenari), the
 * current WIB date in the prompt, at most 30 known entity names. With
 * `MEMORY_EXTRACT=off` or any generate failure a deterministic fallback runs:
 * known-name and capitalized-token matching, no triple, kind note. Writes
 * NEVER block on the model: a slow or failing extraction degrades to the
 * fallback inside a few seconds.
 */
import { Effect } from "effect";
import { Type } from "typebox";
import type { GenerateService } from "../generate/generate.ts";
import type { FactKind } from "@spreissen/contracts";
import { flags } from "./model.ts";
import { normalize } from "./text.ts";

export interface ExtractedFact {
  readonly text: string;
  readonly kind: FactKind;
  /** Entity NAMES as they appear in the text; resolution maps them to ids. */
  readonly entityNames: readonly string[];
  readonly triple: { readonly s: string; readonly p: string; readonly o: string } | null;
  readonly confidence: number;
  /** False when the deterministic fallback produced this. */
  readonly modelExtracted: boolean;
}

export interface ExtractDeps {
  readonly generate?: GenerateService;
}

const KINDS: readonly FactKind[] = ["fact", "preference", "instruction", "event", "note"];

const wibDate = (): string => {
  // WIB = UTC+7, no DST; the date line matters for "today/yesterday" facts.
  const now = new Date(Date.now() + 7 * 3_600_000);
  return now.toISOString().slice(0, 10);
};

const fallback = (text: string, known: readonly string[]): ExtractedFact => {
  const normalized = normalize(text);
  const matched = known.filter((name) => normalized.includes(normalize(name)));
  // Capitalized tokens (original casing) are entity candidates.
  const capitalized = [
    ...new Set(
      (text.match(/\b[A-Z][a-z]{2,}\b/g) ?? []).filter(
        (token) => !matched.some((name) => name.startsWith(token)),
      ),
    ),
  ].slice(0, 4);
  return {
    text,
    kind: "note",
    entityNames: [...matched, ...capitalized].slice(0, 6),
    triple: null,
    confidence: 0.5,
    modelExtracted: false,
  };
};

const ExtractSchema = Type.Object({
  text: Type.String({ description: "The fact, one self-contained sentence." }),
  kind: Type.Union([
    Type.Literal("fact"),
    Type.Literal("preference"),
    Type.Literal("instruction"),
    Type.Literal("event"),
    Type.Literal("note"),
  ]),
  entities: Type.Array(Type.String(), { maxItems: 6 }),
  triple: Type.Union([
    Type.Null(),
    Type.Object({
      s: Type.String({ description: "subject entity name" }),
      p: Type.String({ description: "snake_case active-voice predicate" }),
      o: Type.String({ description: "object entity name or value" }),
    }),
  ]),
});

/**
 * Extract one fact from raw text. `known` are the store's entity names
 * (already capped at 30 by the caller). Any failure — model error, timeout,
 * off-schema reply — lands on the deterministic fallback.
 */
export const extractFact = async (
  deps: ExtractDeps,
  text: string,
  known: readonly string[],
): Promise<ExtractedFact> => {
  const trimmed = text.trim();
  if (!flags.extract() || deps.generate === undefined || trimmed === "") {
    return fallback(trimmed, known);
  }
  const names = known.slice(0, 30);
  const prompt =
    `Today is ${wibDate()} (WIB). Extract ONE durable fact from the note below. Known entity ` +
    `names (use these exact spellings when they match): ` +
    (names.length === 0 ? "(none)" : names.join(", ")) +
    `.\n\nNote:\n${trimmed}`;
  try {
    const extracted = await Promise.race([
      Effect.runPromise(
        deps.generate.extract({
          prompt,
          maxTokens: 2_048,
          schema: ExtractSchema,
        }),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("extract timeout")), 8_000),
      ),
    ]);
    const clean = extracted.text.trim();
    if (clean === "") return fallback(trimmed, known);
    return {
      text: clean.slice(0, 1_000),
      kind: KINDS.includes(extracted.kind) ? extracted.kind : "note",
      entityNames: extracted.entities.filter((name) => typeof name === "string").slice(0, 6),
      triple:
        extracted.triple !== null &&
        typeof extracted.triple.s === "string" &&
        typeof extracted.triple.p === "string" &&
        typeof extracted.triple.o === "string"
          ? extracted.triple
          : null,
      confidence: 0.8,
      modelExtracted: true,
    };
  } catch {
    return fallback(trimmed, known);
  }
};
