/**
 * The Edit-bot dialog's deadline fields: checked before anything is sent, in
 * the same words the server uses (`policyNumberProblem` in @spriessen/contracts).
 * Kept free of UI imports so the root test suite can run it.
 */
import { policyNumberProblem, type PolicyNumberField } from "@spriessen/contracts";

/** What is wrong with a deadline field's text; null when it is fine or empty (the default). */
export const deadlineFieldProblem = (
  text: string | undefined,
  field: PolicyNumberField,
): string | null =>
  text === undefined || text.trim() === "" ? null : policyNumberProblem(field, Number(text.trim()));

/** A deadline field for the patch: "" clears it back to the default (null). */
export const deadlineValue = (
  text: string | undefined,
  field: PolicyNumberField,
): number | null => {
  // JSON would turn NaN into null (the default), so a bad value throws instead.
  const problem = deadlineFieldProblem(text, field);
  if (problem !== null) throw new Error(problem);
  return text === undefined || text.trim() === "" ? null : Number(text.trim());
};

/** The first deadline problem in the form, checked before anything is sent. */
export const formProblem = (form: {
  readonly firstTokenSec?: string | undefined;
  readonly turnMin?: string | undefined;
}): string | null =>
  deadlineFieldProblem(form.firstTokenSec, "firstTokenDeadlineSec") ??
  deadlineFieldProblem(form.turnMin, "turnDeadlineMin");
