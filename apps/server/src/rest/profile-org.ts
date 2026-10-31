/**
 * The org rules on a bot row (slices 2, 3 and 11): a home must name a
 * department that exists (or null, the org), moving into a department
 * needs the right to change it, and a bot's host-access switch is the org
 * owner's alone (F3). Every move and every switch change is audited.
 */
import { may } from "./ask.ts";
import type { RouteArgs } from "./types.ts";

/** One permission audit row for an org-level bot change (move, host flag). */
export const auditedRow = (args: RouteArgs, profile: string, name: string): void => {
  args.mind.audit.record({
    at: Date.now(),
    kind: "permission",
    conversationId: "",
    profile,
    callId: null,
    name,
    durationMs: null,
    ok: true,
    error: null,
  });
};

/** Why a create or patch may not set these org fields: null when it may. */
export const orgFieldsRefusal = async (
  args: RouteArgs,
  fields: { departmentId?: unknown; hostAccess?: unknown },
): Promise<{ status: 400 | 404; error: string } | null> => {
  if (fields.departmentId !== undefined) {
    const target = fields.departmentId;
    if (target !== null && typeof target !== "string") {
      return { status: 400, error: "departmentId is a department id or null (the org)" };
    }
    if (target !== null) {
      const view = await args.mind.org.view();
      if (!view.departments.some((row) => row.id === target)) {
        return { status: 400, error: "unknown department" };
      }
      if (!(await may(args, "change", { type: "department", departmentId: target }))) {
        return { status: 404, error: "unknown profile" };
      }
    }
  }
  if (fields.hostAccess !== undefined && !(await may(args, "change", { type: "host-flag" }))) {
    return { status: 404, error: "unknown profile" };
  }
  return null;
};

/** Audit what an accepted create or patch changed on the org fields. */
export const auditOrgFields = (
  args: RouteArgs,
  id: string,
  fields: { departmentId?: unknown; hostAccess?: unknown },
): void => {
  if (fields.departmentId !== undefined) auditedRow(args, id, "bot-moved");
  if (fields.hostAccess !== undefined) auditedRow(args, id, "host-access-change");
};
