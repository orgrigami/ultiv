/**
 * Branching a chat: a new session that shares the source chat's history up
 * to a point and continues on its own (the source is never changed).
 * "edit" branches BEFORE one of the owner's messages, so the caller can send
 * the edited text there; "from" branches AFTER a bot reply, continuing from
 * it. Transcript ids are entry ids × 100 (the projection's scale), so the
 * entry is `floor(at / 100)`. Only the owner's own chats and main chats
 * branch; tasks and bot threads do not.
 */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { InvalidInput, NotFound } from "@spriessen/core";
import type { SessionInfo } from "@spriessen/contracts";
import { INPUT_ENTRY_KIND } from "../converse/steps.ts";
import { commitSessions, scopedKey } from "./docs.ts";
import { requireProfile } from "./main.ts";
import type { ProfilesContext, ProfilesService } from "./types.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

export type BranchMode = "edit" | "from";

const PAGE = 500;

const isOwnerInput = (entry: EntryRecord): boolean =>
  entry.kind === "pi.user" || entry.kind === INPUT_ENTRY_KIND;

const isReply = (entry: EntryRecord): boolean =>
  (entry.model ?? []).some((message) => message.role === "assistant");

/** Whether a reply also called tools (its results follow in later entries). */
const callsTools = (entry: EntryRecord): boolean =>
  (entry.model ?? []).some(
    (message) =>
      message.role === "assistant" &&
      (message.content as readonly { type?: string }[]).some((block) => block.type === "toolCall"),
  );

const TOOL_RESULT_KIND = "pi.tool-result";

type Located = {
  readonly target: EntryRecord;
  readonly previous: EntryRecord | undefined;
  /** The entries right after the target on the same page, oldest first. */
  readonly following: readonly EntryRecord[];
};

/** The target entry and the entry just before it (oldest-first scan). */
const locate = async (
  ctx: ProfilesContext,
  conversationId: string,
  entryId: number,
): Promise<Located | undefined> => {
  let after = 0;
  let previous: EntryRecord | undefined;
  for (;;) {
    const page = await run(ctx.converse.entriesAfter(conversationId, after, PAGE));
    for (const [index, entry] of page.entries()) {
      if (Number(entry.id) === entryId) {
        return { target: entry, previous, following: page.slice(index + 1) };
      }
      if (Number(entry.id) > entryId) return undefined;
      previous = entry;
    }
    if (page.length < PAGE) return undefined;
    after = Number(page[page.length - 1]?.id ?? after);
  }
};

/** Where the new chat forks: after `previous` for an edit, after the reply itself otherwise. */
const forkPoint = (mode: BranchMode, found: Located): number | null => {
  if (mode === "edit") {
    if (!isOwnerInput(found.target)) {
      throw new InvalidInput({ reason: "only your own messages can be edited" });
    }
    return found.previous === undefined ? null : Number(found.previous.id);
  }
  if (!isReply(found.target)) throw new InvalidInput({ reason: "branch from a bot reply" });
  if (!callsTools(found.target)) return Number(found.target.id);
  // A reply that called tools continues after its round: take its results
  // along, or the new chat would hold calls without answers.
  let last = found.target;
  for (const entry of found.following) {
    if (entry.kind !== TOOL_RESULT_KIND) break;
    last = entry;
  }
  return Number(last.id);
};

export const branchOps = (ctx: ProfilesContext): Pick<ProfilesService, "branchSession"> => ({
  branchSession: async (owner, sessionId, at, mode) => {
    const source = await ctx.self().rowOf(sessionId);
    if (source === undefined || source.owner !== owner) {
      throw new NotFound({ what: `session ${sessionId}` });
    }
    if (source.kind !== "session" && source.kind !== "main") {
      throw new InvalidInput({ reason: "only your chats can be branched" });
    }
    const profile = await requireProfile(ctx, owner, source.profile);
    const conversationId = await run(
      ctx.converse.conversationIdOf(await ctx.self().keyOfRow(source)),
    );
    const found =
      conversationId === undefined
        ? undefined
        : await locate(ctx, String(conversationId), Math.floor(at / 100));
    if (conversationId === undefined || found === undefined) {
      throw new NotFound({ what: `message ${at} in this chat` });
    }
    const point = forkPoint(mode, found);
    const row: SessionInfo = {
      id: randomUUID(),
      owner,
      profile: source.profile,
      kind: "session",
      participants: null,
      title: `${source.title === "" ? "Chat" : source.title} (branch)`.slice(0, 120),
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      branchOf: { sessionId, at },
    };
    const key = scopedKey(owner, source.profile, row.id);
    // Editing the very first message has nothing before it: a fresh chat.
    if (point !== null) await run(ctx.converse.forkInto(String(conversationId), point, key));
    await ctx.index.ensureConversationFor(key, profile, {
      owner,
      profileId: source.profile,
      kind: "session",
      participants: null,
    });
    await run(commitSessions(ctx.converse, (sessions) => [...sessions, row]));
    return row;
  },
});
