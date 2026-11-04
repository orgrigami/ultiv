/**
 * POST /api/memory/v2/facts/:id/update?profile=<id|owner>
 *   { op: "change" | "correct" | "end" | "confirm", text?, at? }
 *
 * The owner's memory_update: the same lifecycle a bot runs on its facts,
 * from the Memory panel. `change` keeps the old version as the past,
 * `correct` replaces a wrong one from the start (it is never shown again),
 * `end` retires a fact (from `at`, a day, default today), `confirm` firms
 * an inference up. Stores are keyed by the caller's owner, so another
 * owner's fact reads as missing. Audited as memory.fact.<op>.
 */
import { parseWhen } from "@spriessen/mind";
import type { RouteArgs } from "./types.ts";

type Body = { op?: string; text?: string; at?: string };

export async function factUpdateRoute(
  args: RouteArgs,
  profile: string | undefined,
): Promise<boolean> {
  const match = args.path.match(/^\/api\/memory\/v2\/facts\/([^/]+)\/update$/);
  if (match === null || args.req.method !== "POST") return false;
  const id = decodeURIComponent(match[1] ?? "");
  const profileId = profile === undefined || profile === "owner" ? null : profile;
  const body = await args.readJson<Body>(args.req);
  const fail = (status: number, error: string): boolean => {
    args.json(status, { error });
    return true;
  };
  try {
    if (body.op === "change" || body.op === "correct") {
      const text = (body.text ?? "").trim();
      if (text === "") return fail(400, "the new text of the fact is missing");
      const validFrom = body.op === "change" ? parseWhen(body.at) : undefined;
      const result = await args.mind.memory.writeV2({
        owner: args.owner,
        profileId,
        scope: profileId === null ? "owner" : "profile",
        writer: null,
        text,
        basis: "owner_said",
        replaces: id,
        ...(validFrom !== undefined ? { validFrom } : {}),
        ...(body.op === "correct" ? { correction: true } : {}),
      });
      record(args, profile, `memory.fact.${body.op}`);
      args.json(200, { ok: true, id: result.id, op: result.op });
      return true;
    }
    if (body.op === "end") {
      const ended = await args.mind.memory.end(args.owner, profileId, id, parseWhen(body.at), null);
      record(args, profile, "memory.fact.end");
      args.json(200, { ok: true, id: ended.id, endsAt: ended.endsAt, retired: ended.retired });
      return true;
    }
    if (body.op === "confirm") {
      const confirmed = await args.mind.memory.confirm(args.owner, profileId, id, null);
      record(args, profile, "memory.fact.confirm");
      args.json(200, { ok: true, id: confirmed.id, confirmations: confirmed.confirmations });
      return true;
    }
    return fail(400, "op must be change, correct, end or confirm");
  } catch (cause) {
    const error = cause as { reason?: unknown; what?: unknown; _tag?: unknown };
    if (typeof error.what === "string") return fail(404, `unknown ${error.what}`);
    if (typeof error.reason === "string") return fail(409, error.reason);
    throw cause;
  }
}

const record = (args: RouteArgs, profile: string | undefined, name: string): void =>
  args.mind.audit.record({
    at: Date.now(),
    kind: "memory",
    conversationId: "",
    profile: profile ?? null,
    callId: null,
    name,
    durationMs: null,
    ok: true,
    error: null,
  });
