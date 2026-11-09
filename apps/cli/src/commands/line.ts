/**
 * What waits on you, from the command line: `needs` (cards, browser
 * takeover asks, failed tasks, memory reviews, parked work) and `approve` / `deny`. Card ids may be
 * shortened like every other id. `approve --all` shows what it is about to
 * approve and asks first (`--yes` skips that); cards that are asked every
 * time on purpose (a credential's or connector's first use, connector
 * changes, secure inputs, scripts beyond the bot's VM) stay waiting for a
 * look of their own.
 */
import { createInterface } from "node:readline/promises";
import { boolFlag, type Parsed } from "../args.ts";
import type { Api, ApprovalRow } from "../client/http.ts";
import { paintFor, print, shortId } from "../render/out.ts";
import { cardWords } from "../render/words.ts";
import { apiFor, namesOf, NoMatch } from "./context.ts";

const cardLine = (row: ApprovalRow, names: Map<string, string>): string => {
  const paint = paintFor();
  const words = cardWords(row);
  const hint = words.hint !== null ? paint.dim(` (${words.hint})`) : "";
  return `${paint.amber(shortId(row.callId))}  ${names.get(row.profile) ?? row.profile} wants to ${words.action}${hint}`;
};

export const needs = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  const [rows, tasks, names, extra] = await Promise.all([
    api.approvals(),
    api.tasks(),
    namesOf(api),
    api.needsYou(),
  ]);
  const paint = paintFor();
  const failed = tasks.filter((task) => task.status === "failed");
  const tidy = extra.tidy.reduce((sum, row) => sum + row.open, 0);
  const parked = extra.parked ?? [];
  const takeovers = extra.takeovers ?? [];
  print(parsed, { approvals: rows, failed, extra }, () => {
    const lines = rows.map((row) => cardLine(row, names));
    for (const ask of takeovers) {
      const who = names.get(ask.profile) ?? "A bot";
      lines.push(
        `${paint.amber("◆")} ${who} waits for you at its browser: ${ask.reason} (web app: Browsers)`,
      );
    }
    for (const task of failed) {
      const who = names.get(task.bot?.profileId ?? "") ?? "A bot";
      lines.push(
        `${paint.red("✗")} ${who}'s task ${shortId(task.id)} failed: ${task.error ?? "no reason given"}`,
      );
    }
    if (tidy > 0) lines.push(`${tidy} memory proposal(s) to review (web app: Needs you)`);
    if (parked.length > 0) {
      lines.push(
        `${parked.length} parked task(s) cut off by restarts (web app: Needs you › Retry)`,
      );
    }
    if (lines.length === 0) return ["Nothing needs you."];
    if (rows.length > 0) {
      lines.push("", paint.dim("Answer with: spriessen approve <id> | spriessen deny <id>"));
    }
    if (failed.length > 0) lines.push(paint.dim("Read a failed task: spriessen tasks show <id>"));
    return lines;
  });
};

/** The waiting card an id (or its start) names. */
const findCard = (rows: readonly ApprovalRow[], wanted: string): ApprovalRow => {
  const exact = rows.find((row) => row.callId === wanted);
  if (exact !== undefined) return exact;
  const starts = wanted.length >= 4 ? rows.filter((row) => row.callId.startsWith(wanted)) : [];
  if (starts.length === 1) return starts[0] as ApprovalRow;
  throw new NoMatch(
    starts.length > 1
      ? `More than one card starts with ${wanted}; give more of the id`
      : `Nothing is waiting with the id ${wanted} (see: spriessen needs)`,
  );
};

/** Cards a bulk approve leaves alone: asked every time on purpose, or reaching past the VM. */
export const needsOwnLook = (row: Pick<ApprovalRow, "name" | "input">): boolean => {
  if (cardWords({ ...row, callId: "", reason: null }).always === null) return true;
  const target =
    typeof row.input === "object" && row.input !== null
      ? (row.input as Record<string, unknown>)["target"]
      : undefined;
  return target === "host" || target === "node";
};

const confirm = async (question: string): Promise<boolean> => {
  if (process.stdin.isTTY !== true) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
};

const approveAll = async (api: Api, parsed: Parsed): Promise<number> => {
  const [rows, names] = await Promise.all([api.approvals(), namesOf(api)]);
  const bulk = rows.filter((row) => !needsOwnLook(row));
  const held = rows.length - bulk.length;
  if (bulk.length === 0) {
    console.log(
      held > 0 ? `${held} card(s) wait, each needing its own look.` : "Nothing is waiting.",
    );
    return 0;
  }
  for (const row of bulk) console.log(cardLine(row, names));
  if (!boolFlag(parsed, "yes") && !(await confirm(`Approve these ${bulk.length}? [y/N] `))) {
    console.log("Nothing approved. (In a script, add --yes.)");
    return 1;
  }
  const results = await Promise.all(bulk.map((row) => api.decide(row, true)));
  const taken = results.filter((result) => result.ok).length;
  console.log(
    `Approved ${taken} of ${bulk.length}.` +
      (held > 0 ? ` ${held} more wait for their own look (spriessen needs).` : ""),
  );
  return taken === bulk.length ? 0 : 1;
};

export const decide = async (parsed: Parsed, approved: boolean): Promise<number> => {
  const api = apiFor(parsed);
  if (approved && boolFlag(parsed, "all")) return approveAll(api, parsed);
  const callId = parsed.positionals[1];
  if (callId === undefined) {
    throw new Error(
      `usage: spriessen ${approved ? "approve" : "deny"} <id>  (ids from \`spriessen needs\`)`,
    );
  }
  const row = findCard(await api.approvals(), callId);
  const always = approved && boolFlag(parsed, "always");
  if (always && cardWords(row).always === null) {
    throw new Error("this card is asked every time on purpose; approve it once instead");
  }
  const result = await api.decide(row, approved, always);
  if (!result.ok) throw new Error("the server did not take the decision (it may have moved on)");
  console.log(
    approved ? (always ? "Approved, and saved as always allowed." : "Approved.") : "Denied.",
  );
  return 0;
};
