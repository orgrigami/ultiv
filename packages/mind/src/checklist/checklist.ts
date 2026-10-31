/**
 * The checklist's rules, pure: a call either replaces the whole list
 * (`items`) or changes items by number (`update`). Caps keep it a short plan,
 * and at most one item is in progress at a time. A fresh list after a
 * finished one is a new card (new id); re-planning an unfinished list keeps
 * its card.
 */
import {
  CHECKLIST_MAX_ITEMS,
  CHECKLIST_MAX_TEXT,
  CHECKLIST_MAX_TITLE,
  type ChecklistDetails,
  type ChecklistItem,
  type ChecklistParams,
} from "@spriessen/contracts";

export type Applied =
  | { readonly ok: true; readonly list: ChecklistDetails }
  | { readonly ok: false; readonly error: string };

const fail = (error: string): Applied => ({ ok: false, error });

const textProblem = (text: string, at: number): string | undefined => {
  if (text.trim() === "") return `item ${at} has no text`;
  if (text.length > CHECKLIST_MAX_TEXT) {
    return `item ${at} is longer than ${CHECKLIST_MAX_TEXT} characters; keep each step short`;
  }
  return undefined;
};

const finished = (list: ChecklistDetails | undefined): boolean =>
  list === undefined || list.items.every((item) => item.status === "done");

const replaced = (
  current: ChecklistDetails | undefined,
  items: readonly ChecklistItem[],
  title: string | undefined,
  newId: () => string,
): Applied => {
  if (items.length === 0) return fail("items is empty; send at least one step");
  if (items.length > CHECKLIST_MAX_ITEMS) {
    return fail(`at most ${CHECKLIST_MAX_ITEMS} items; group smaller steps together`);
  }
  for (const [index, item] of items.entries()) {
    const problem = textProblem(item.text, index + 1);
    if (problem !== undefined) return fail(problem);
  }
  const same = current !== undefined && !finished(current);
  return {
    ok: true,
    list: {
      listId: same ? current.listId : newId(),
      title: title ?? (same ? current.title : null),
      items: items.map((item) => ({ text: item.text.trim(), status: item.status })),
    },
  };
};

const updated = (
  current: ChecklistDetails | undefined,
  changes: NonNullable<ChecklistParams["update"]>,
  title: string | undefined,
): Applied => {
  if (current === undefined) return fail("there is no checklist yet; send items to start one");
  const items = current.items.map((item) => ({ ...item }));
  for (const change of changes) {
    const item = items[change.item - 1];
    if (item === undefined) {
      return fail(`there is no item ${change.item}; the list has ${items.length}`);
    }
    if (change.text !== undefined) {
      const problem = textProblem(change.text, change.item);
      if (problem !== undefined) return fail(problem);
      item.text = change.text.trim();
    }
    if (change.status !== undefined) item.status = change.status;
  }
  return { ok: true, list: { ...current, title: title ?? current.title, items } };
};

/** One call against the current list. `newId` mints a card id for a fresh list. */
export const applyChecklist = (
  current: ChecklistDetails | undefined,
  args: ChecklistParams,
  newId: () => string,
): Applied => {
  if ((args.items === undefined) === (args.update === undefined)) {
    return fail("send either items (the whole list) or update (changes by number), not both");
  }
  const title = args.title?.trim();
  if (title !== undefined && title.length > CHECKLIST_MAX_TITLE) {
    return fail(`the title is longer than ${CHECKLIST_MAX_TITLE} characters`);
  }
  const named = title === "" ? undefined : title;
  const result =
    args.items !== undefined
      ? replaced(current, args.items, named, newId)
      : updated(current, args.update ?? [], named);
  if (!result.ok) return result;
  const working = result.list.items.flatMap((item, index) =>
    item.status === "in_progress" ? [index + 1] : [],
  );
  if (working.length > 1) {
    return fail(
      `only one item may be in progress at a time (items ${working.join(" and ")} are); ` +
        "mark the finished one done in the same call",
    );
  }
  return result;
};

const MARKS = { pending: "[ ]", in_progress: "[>]", done: "[x]" } as const;

/** The list as the model reads it back. */
export const checklistText = (list: ChecklistDetails): string => {
  const done = list.items.filter((item) => item.status === "done").length;
  const head = `${list.title !== null ? `"${list.title}" ` : ""}${done}/${list.items.length} done`;
  const rows = list.items.map(
    (item, index) =>
      `${index + 1}. ${MARKS[item.status]} ${item.text}${item.status === "in_progress" ? " (in progress)" : ""}`,
  );
  const tail = done === list.items.length ? "\nAll done." : "";
  return `Checklist ${head}:\n${rows.join("\n")}${tail}`;
};
