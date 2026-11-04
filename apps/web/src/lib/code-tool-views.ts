/**
 * The code tools in owner words: `code_outline` (a file and symbol tree),
 * `code_nav` (where a symbol is defined or used) and `file_find` (files by
 * name pattern). Each reads as one line plus its result as a mono plate; the argument
 * names come from `@spriessen/ext` (plugins/code-intel.ts, plugins/files.ts).
 */
import type { ToolStep } from "@spriessen/contracts";
import type { RecordField, ToolView } from "./tool-text.ts";

const recordOf = (value: unknown): Record<string, unknown> => {
  if (typeof value === "string") {
    try {
      return recordOf(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

type Words = readonly [done: string, live: string, failed: string];

/** code_nav's words follow its action: definitions vs references. */
const navWords = (action: unknown, symbol: string | undefined): Words => {
  const name = symbol === undefined ? "a symbol" : `“${clip(symbol, 40)}”`;
  return action === "references"
    ? [`Found where ${name} is used`, `Finding where ${name} is used…`, `Couldn't find uses`]
    : [`Found where ${name} is defined`, `Finding where ${name} is defined…`, "Couldn't find it"];
};

const wordsOf = (name: string, input: Record<string, unknown>): Words | null => {
  switch (name) {
    case "code_outline":
      return ["Outlined the code", "Outlining the code…", "Couldn't outline it"];
    case "code_nav":
      return navWords(input["action"], textOf(input["name"]));
    case "file_find":
      return ["Found files by name", "Looking for files…", "Couldn't look"];
    default:
      return null;
  }
};

const fieldsOf = (input: Record<string, unknown>): RecordField[] => {
  const fields: RecordField[] = [];
  const pattern = textOf(input["pattern"]);
  if (pattern !== undefined) fields.push({ k: "Pattern", v: pattern, mono: true });
  const path = textOf(input["path"]);
  fields.push({
    k: "In",
    v: path ?? "all its files",
    ...(path !== undefined ? { mono: true } : {}),
  });
  if (typeof input["depth"] === "number") fields.push({ k: "Depth", v: String(input["depth"]) });
  return fields;
};

/** The owner's lens on one code-tool call, or null when it isn't one. */
export function codeView(step: ToolStep): ToolView | null {
  const input = recordOf(step.input);
  const words = wordsOf(step.name, input);
  if (words === null) return null;
  const [done, live, failed] = words;
  const output =
    typeof step.output === "string" && step.output.trim() !== ""
      ? clip(step.output.trim(), 8000)
      : undefined;
  const scope = textOf(input["pattern"]) ?? textOf(input["path"]);
  return {
    family: step.name === "file_find" ? "artifact" : "code",
    done: step.status === "error" ? failed : done,
    live,
    ...(scope !== undefined && step.name !== "code_nav" ? { detail: clip(scope, 36) } : {}),
    // The result is an indented tree or a hit list: the mono output plate
    // keeps its shape. Before it arrives, the record shows what was asked.
    structured:
      output !== undefined
        ? { t: "output", text: output }
        : { t: "record", fields: fieldsOf(input) },
  };
}
