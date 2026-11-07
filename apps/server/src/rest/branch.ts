/**
 * POST /api/sessions/:id/branch — branch a chat (`profiles.branchSession`):
 * `{ at, mode: "from" }` continues from a bot reply in a new chat;
 * `{ at, mode: "edit", text }` forks before one of the owner's messages and
 * sends the edited text there. The source chat is never changed. Another
 * owner's chat answers exactly like a missing one (404).
 */
import { Effect } from "effect";
import { MAX_EDIT_CHARS } from "@spriessen/contracts";
import { errorOf, type RouteArgs } from "./types.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

type BranchBody = { at?: unknown; mode?: unknown; text?: unknown };

/** The request's problem, or null when it is well formed. */
const problemOf = (body: BranchBody): string | null => {
  if (typeof body.at !== "number" || !Number.isSafeInteger(body.at) || body.at < 0) {
    return "at must be a message id";
  }
  if (body.mode !== "edit" && body.mode !== "from") return "mode must be edit or from";
  if (body.mode === "edit") {
    if (typeof body.text !== "string" || body.text.trim() === "") return "the edited text is empty";
    if (body.text.length > MAX_EDIT_CHARS)
      return `the edited text is over ${MAX_EDIT_CHARS} characters`;
  }
  return null;
};

/** Send the edited message into the new chat; the turn settles in the background. */
const sendEdit = async (args: RouteArgs, sessionId: string, text: string): Promise<void> => {
  const { mind } = args;
  const conversation = await run(
    mind.converse.ensure(await mind.profiles.keyForSession(args.owner, sessionId)),
  );
  const submission = await run(mind.converse.submit(conversation, text));
  await mind.profiles.touchSession(args.owner, sessionId, { at: Date.now() });
  void run(mind.converse.settle(conversation, submission)).catch((cause) => {
    console.error("branch turn failed:", cause);
  });
};

export async function branchRoutes(args: RouteArgs): Promise<boolean> {
  const match = /^\/api\/sessions\/([^/]+)\/branch$/.exec(args.path);
  if (match === null || args.req.method !== "POST") return false;
  const sessionId = decodeURIComponent(match[1] ?? "");
  const body = await args.readJson<BranchBody>(args.req);
  const problem = problemOf(body);
  if (problem !== null) {
    args.json(400, { error: problem });
    return true;
  }
  try {
    const mode = body.mode as "edit" | "from";
    const session = await args.mind.profiles.branchSession(
      args.owner,
      sessionId,
      body.at as number,
      mode,
    );
    if (mode === "edit") await sendEdit(args, session.id, body.text as string);
    args.json(200, session);
  } catch (cause) {
    const missing = (cause as { _tag?: string })._tag === "spriessen/NotFound";
    args.json(missing ? 404 : 400, { error: missing ? "no such message" : errorOf(cause) });
  }
  return true;
}
