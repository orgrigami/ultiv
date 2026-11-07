/**
 * Reading a JSON value out of a model's reply: a fenced block or the bare
 * text, else the outermost object (or array) inside it. Shared by the
 * generate faculty and structured task results. Undefined when nothing in
 * the reply parses.
 */
const tryParse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const between = (text: string, open: string, close: string): string | undefined => {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
};

export const parseJsonReply = (text: string): unknown => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const object = between(candidate, "{", "}");
  if (object !== undefined) {
    const parsed = tryParse(object);
    if (parsed !== undefined) return parsed;
  }
  const array = between(candidate, "[", "]");
  if (array !== undefined) {
    const parsed = tryParse(array);
    if (parsed !== undefined) return parsed;
  }
  return tryParse(candidate);
};
