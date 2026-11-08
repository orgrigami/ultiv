/**
 * Structured task results: a spawn may give a JSON Schema its result must
 * match. The brief asks for ONLY that JSON; when the task's final reply does
 * not parse or does not match, the task gets ONE repair turn in its own
 * conversation. The validated value is stored as `structured` (and the
 * result text becomes its pretty JSON); a value that never matched stores
 * `structured: null` and keeps the raw text, so nothing the task wrote is lost.
 */
import type { Conversation } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { compile, type Schema } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import type { Json } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { parseJsonReply } from "../json-reply.ts";

/** The largest schema a spawn may pass, as JSON text. */
export const RESULT_SCHEMA_MAX_CHARS = 8_000;

/** Why a schema is refused, or null when it is usable. */
export const resultSchemaProblem = (schema: unknown): string | null => {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return "result_schema must be a JSON Schema object";
  }
  const record = schema as Record<string, unknown>;
  if (record.type === undefined && record.properties === undefined && record.items === undefined) {
    return "result_schema needs a type (e.g. object) or properties";
  }
  if (JSON.stringify(schema).length > RESULT_SCHEMA_MAX_CHARS) {
    return `result_schema is too large (max ${RESULT_SCHEMA_MAX_CHARS} characters)`;
  }
  return null;
};

/** The line appended to the task's brief. */
export const schemaBrief = (schema: unknown): string =>
  "\n\n[result format] Your final reply is read by a program: reply with ONLY a JSON value " +
  `matching this JSON Schema, no prose and no code fence:\n${JSON.stringify(schema)}`;

export type ResultCheck =
  | { readonly ok: true; readonly value: Json }
  | { readonly ok: false; readonly reason: string };

/** Whether a reply carries JSON that matches the schema. */
export const checkResult = (schema: unknown, text: string): ResultCheck => {
  const value = parseJsonReply(text);
  if (value === undefined) return { ok: false, reason: "the reply is not JSON" };
  const errors = compile(schema as Schema, { formats, unresolvedRefs: "reject" })
    .errors(value)
    .slice(0, 3);
  // Parsed from JSON text, so it is a JSON value.
  if (errors.length === 0) return { ok: true, value: value as Json };
  const lines = errors.map(
    (error) => `${error.path === "" ? "(root)" : error.path} ${error.message}`,
  );
  return { ok: false, reason: lines.join("; ") };
};

const repairPrompt = (reason: string): string =>
  `[result check] Your final reply did not match the result format (${reason}). Reply again ` +
  "with ONLY the corrected JSON value.";

export type StructuredOutcome = { readonly result: string; readonly structured: Json };

/** Check a task's final reply against its schema, with one repair turn. */
export const settleStructured = async (
  converse: ConverseService,
  conversation: Conversation,
  schema: Json,
  text: string,
): Promise<StructuredOutcome> => {
  const first = checkResult(schema, text);
  if (first.ok) return { result: JSON.stringify(first.value, null, 2), structured: first.value };
  const again = await Effect.runPromise(converse.turn(conversation, repairPrompt(first.reason)));
  const second = checkResult(schema, again.text);
  if (second.ok) return { result: JSON.stringify(second.value, null, 2), structured: second.value };
  return { result: again.text.trim() !== "" ? again.text : text, structured: null };
};
