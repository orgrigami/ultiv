/**
 * Grading a replay: the case's expectations as plain checks (tools called or
 * not, phrases present), then Jev: the probability that the new reply serves
 * the owner's message at least as well as the reference did, and whether it
 * meets the case's own rule. A case passes when every check passes and each
 * Jev answer is at least 0.5. Without Jev the checks decide alone.
 */
import { Effect } from "effect";
import type { EvalCase, EvalCheck, EvalExpect, EvalResult } from "@spriessen/contracts";
import type { DecideService } from "../decide/decide.ts";
import type { ReplayOutcome } from "./replay.ts";

export const PASS_SCORE = 0.5;

const COMPARE =
  "Does the CANDIDATE reply serve the owner's message at least as well as the REFERENCE " +
  "reply did? Judge substance: correct, complete, and doing what the owner asked (tools " +
  "could not run in the candidate's replay, so a stated plan to use one counts). Ignore " +
  "wording and length.";

/** The case's expectations against the replay, one check each. */
export const checksOf = (expect: EvalExpect, outcome: ReplayOutcome): EvalCheck[] => {
  const reply = outcome.reply.toLowerCase();
  return [
    ...(expect.tools ?? []).map((name) => ({
      name: `calls ${name}`,
      ok: outcome.tools.includes(name),
      detail: outcome.tools.length === 0 ? "called no tools" : `called ${outcome.tools.join(", ")}`,
    })),
    ...(expect.notTools ?? []).map((name) => ({
      name: `does not call ${name}`,
      ok: !outcome.tools.includes(name),
      detail: outcome.tools.includes(name) ? `called ${name}` : "not called",
    })),
    ...(expect.contains ?? []).map((phrase) => ({
      name: `says "${phrase}"`,
      ok: reply.includes(phrase.toLowerCase()),
      detail: reply.includes(phrase.toLowerCase()) ? "found" : "not in the reply",
    })),
  ];
};

const stateOf = (item: EvalCase, outcome: ReplayOutcome): string =>
  `Owner's message:\n${item.input}\n\nREFERENCE reply (tools: ${item.reference.tools.join(", ") || "none"}):\n` +
  `${item.reference.reply || "(no text)"}\n\nCANDIDATE reply (tools: ${outcome.tools.join(", ") || "none"}):\n` +
  `${outcome.reply || "(no text)"}`;

const ask = async (
  decide: DecideService,
  state: string,
  question: string,
): Promise<number | null> =>
  Effect.runPromise(decide.yesNo(state, question)).catch((cause: unknown) => {
    console.error("eval grading (Jev) failed:", cause);
    return null;
  });

export const gradeCase = async (
  decide: DecideService | undefined,
  item: EvalCase,
  outcome: ReplayOutcome,
): Promise<EvalResult> => {
  const checks = checksOf(item.expect, outcome);
  const base = { caseId: item.id, reply: outcome.reply, tools: outcome.tools, checks };
  if (outcome.error !== null) return { ...base, ok: false, score: null, error: outcome.error };
  const judge = decide?.available === true ? decide : undefined;
  const state = stateOf(item, outcome);
  const score = judge === undefined ? null : await ask(judge, state, COMPARE);
  const rubric = item.expect.rubric?.trim() ?? "";
  if (judge !== undefined && rubric !== "") {
    const met = await ask(judge, state, `Does the CANDIDATE reply meet this rule: ${rubric}`);
    checks.push({
      name: `meets: ${rubric}`.slice(0, 120),
      ok: met !== null && met >= PASS_SCORE,
      detail: met === null ? "Jev did not answer" : `Jev: ${met.toFixed(2)}`,
    });
  }
  const answered = outcome.reply.trim() !== "" || outcome.tools.length > 0;
  const ok =
    answered && checks.every((check) => check.ok) && (score === null || score >= PASS_SCORE);
  return { ...base, ok, score, error: null };
};
