/**
 * Memory v2 REST: the human surface over the facts/core/proposals docs —
 * the owner reads and decides, the tidy proposes. Scoped to the signed-in
 * account like every route. Purge is irreversible and human-only.
 */
import { Effect } from "effect";
import type { MemoryProposal } from "@spriessen/contracts";
import {
  decideProposal,
  FactsDoc,
  ownerKey,
  profileKey,
  ProposalsDoc,
  teamKey,
} from "@spriessen/mind";
import { may } from "./ask.ts";
import { errorOf, type RouteArgs } from "./types.ts";
import { runTidy, tidyPush } from "../memory-tidy.ts";
import { factUpdateRoute } from "./memory-facts.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

const keyOf = (owner: string, profile: string | undefined): string =>
  profile === undefined || profile === "owner" ? ownerKey(owner) : profileKey(owner, profile);

/** The proposals the owner sees: not rejected, and open ones at most 30 days old. */
export const visibleProposals = (
  proposals: readonly MemoryProposal[],
  now: number,
): MemoryProposal[] =>
  proposals.filter(
    (proposal) =>
      proposal.status !== "rejected" &&
      !(proposal.status === "open" && now - proposal.at > 30 * 24 * 3_600_000),
  );

/** GET /api/memory/v2?profile=<id|owner> — facts, entities, core, proposals. */
const readStore = async (args: RouteArgs, profile: string | undefined) => {
  const owner = args.owner;
  const key = keyOf(owner, profile);
  const [facts, entities, ownerCore, profileCore, proposals] = await Promise.all([
    args.mind.memory.readFacts(
      owner,
      profile === undefined || profile === "owner" ? null : profile,
    ),
    args.mind.memory.entities(owner, profile === undefined || profile === "owner" ? null : profile),
    args.mind.memory.core.read(owner, null),
    profile === undefined || profile === "owner"
      ? Promise.resolve([])
      : args.mind.memory.core.read(owner, profile),
    run(args.mind.converse.docs.snapshotKeyed(ProposalsDoc, key)).then(
      (store) => store?.proposals ?? [],
    ),
  ]);
  const visible = visibleProposals(proposals, Date.now());
  return {
    facts,
    chats: profile === undefined || profile === "owner" ? {} : await chatsOf(args, profile),
    entities,
    core: { owner: ownerCore, profile: profileCore },
    proposals: visible.sort((a, b) => b.at - a.at),
    openCount: visible.filter((proposal) => proposal.status === "open").length,
  };
};

/**
 * Where facts were learned: the bot's chats by conversation id, so a fact's
 * `source.conversation` opens the chat it came from ("Learned in …").
 */
const chatsOf = async (
  args: RouteArgs,
  profile: string,
): Promise<Record<string, { sessionId: string; title: string; kind: string }>> => {
  const rows = await args.mind.profiles.listSessions(args.owner, profile);
  const entries = await Promise.all(
    rows.map(async (row) => {
      const key = await args.mind.profiles.keyOfRow(row);
      const conversation = await run(args.mind.converse.conversationIdOf(key));
      return conversation === undefined
        ? []
        : [[conversation, { sessionId: row.id, title: row.title, kind: row.kind }] as const];
    }),
  );
  return Object.fromEntries(entries.flat());
};

/** The memory-v2 routes; returns false when the path is not ours. */
export async function memoryV2Routes(args: RouteArgs): Promise<boolean> {
  const { path, json } = args;
  const method = args.req.method ?? "GET";
  if (
    !path.startsWith("/api/memory/v2") &&
    !path.startsWith("/api/memory/tidy") &&
    !path.startsWith("/api/memory/purge")
  ) {
    return false;
  }
  const profile = args.url.searchParams.get("profile") ?? undefined;
  // `department` is the pre-rename name older clients still send.
  const team =
    args.url.searchParams.get("team") ?? args.url.searchParams.get("department") ?? undefined;
  // A team's shared store: its admins (and the org level) read it and
  // decide its proposals; members and viewers read as missing.
  if (team !== undefined) {
    if (!(await may(args, "change", { type: "team", teamId: team }))) {
      json(404, { error: "unknown team" });
      return true;
    }
  }
  try {
    if (path === "/api/memory/v2" && method === "GET" && team !== undefined) {
      const key = teamKey(args.owner, team);
      const [facts, proposals] = await Promise.all([
        run(args.mind.converse.docs.snapshotKeyed(FactsDoc, key)).then((d) => d?.facts ?? []),
        run(args.mind.converse.docs.snapshotKeyed(ProposalsDoc, key)).then(
          (d) => d?.proposals ?? [],
        ),
      ]);
      json(200, {
        facts: facts.filter((fact) => fact.status === "current"),
        proposals: visibleProposals(proposals, Date.now()),
        core: [],
        entities: [],
        openCount: proposals.filter((p) => p.status === "open").length,
      });
      return true;
    }
    if (path === "/api/memory/v2" && method === "GET") {
      json(200, await readStore(args, profile));
      return true;
    }
    if (path === "/api/memory/tidy/run" && method === "POST") {
      const push = args.push;
      const result = await runTidy(
        {
          mind: args.mind,
          ...(push !== undefined ? { notify: tidyPush(push.notifier) } : {}),
        },
        args.owner,
      );
      json(200, result);
      return true;
    }
    if (path === "/api/memory/purge" && method === "POST") {
      const target = profile === undefined || profile === "owner" ? null : profile;
      // Server-side confirmation: `confirm` must echo the number of facts
      // about to lose their text. A bare POST never purges.
      const body = await args.readJson<{ confirm?: number }>(args.req).catch(
        () =>
          ({}) as {
            confirm?: number;
          },
      );
      const pending = (await args.mind.memory.readFacts(args.owner, target)).filter(
        (fact) => fact.status === "forgotten" && fact.text !== "",
      ).length;
      if (body.confirm !== pending) {
        json(400, {
          error: `confirm must echo the count of facts losing their text (${pending})`,
          forgotten: pending,
        });
        return true;
      }
      const purged = await args.mind.memory.purge(args.owner, target);
      args.mind.audit.record({
        at: Date.now(),
        kind: "memory",
        conversationId: "",
        profile: null,
        callId: null,
        name: "memory.purge",
        durationMs: null,
        ok: true,
        error: null,
      });
      json(200, { purged });
      return true;
    }
    if (await factUpdateRoute(args, profile)) return true;
    const factMatch = path.match(/^\/api\/memory\/v2\/facts\/([^/]+)$/);
    if (factMatch !== null && method === "DELETE") {
      // The owner's unconditional tombstone (restore or purge from here).
      await args.mind.memory.tombstone(
        args.owner,
        profile === undefined || profile === "owner" ? null : profile,
        factMatch[1] ?? "",
      );
      args.mind.audit.record({
        at: Date.now(),
        kind: "memory",
        conversationId: "",
        profile: profile ?? null,
        callId: null,
        name: "memory.fact.tombstone",
        durationMs: null,
        ok: true,
        error: null,
      });
      json(200, { ok: true });
      return true;
    }
    const restoreMatch = path.match(/^\/api\/memory\/v2\/facts\/([^/]+)\/restore$/);
    if (restoreMatch !== null && method === "POST") {
      // The owner's undo of a tombstone (the "Forgotten" list in the panel).
      // A purged tombstone has no text left: 409, never an empty fact.
      try {
        await args.mind.memory.restore(
          args.owner,
          profile === undefined || profile === "owner" ? null : profile,
          restoreMatch[1] ?? "",
        );
      } catch (cause) {
        const error = cause as { reason?: unknown; what?: unknown };
        if (typeof error.what === "string") json(404, { error: `unknown ${error.what}` });
        else if (typeof error.reason === "string") json(409, { error: error.reason });
        else throw cause;
        return true;
      }
      args.mind.audit.record({
        at: Date.now(),
        kind: "memory",
        conversationId: "",
        profile: profile ?? null,
        callId: null,
        name: "memory.fact.restore",
        durationMs: null,
        ok: true,
        error: null,
      });
      json(200, { ok: true });
      return true;
    }
    const proposalMatch = path.match(/^\/api\/memory\/v2\/proposals\/([^/]+)\/(accept|reject)$/);
    if (proposalMatch !== null && method === "POST" && team !== undefined) {
      const [, id, verdict] = proposalMatch;
      const outcome = await args.mind.memory.decideShare({
        owner: args.owner,
        teamId: team,
        proposalId: id ?? "",
        accept: verdict === "accept",
      });
      if (outcome === "unknown") {
        json(404, { error: `proposal ${id} not found` });
        return true;
      }
      json(200, { id, status: outcome });
      return true;
    }
    if (proposalMatch !== null && method === "POST") {
      const [, id, verdict] = proposalMatch;
      // A conflict's accept names the fact that holds: `{ keep: <fact id> }`.
      const body = await args
        .readJson<{ keep?: unknown }>(args.req)
        .catch(() => ({}) as { keep?: unknown });
      // One commit: the facts and the proposal's status change together.
      const outcome = await decideProposal(
        args.mind.converse,
        keyOf(args.owner, profile),
        id ?? "",
        verdict === "accept" ? "accept" : "reject",
        typeof body.keep === "string" ? body.keep : undefined,
      );
      if (outcome.kind === "unknown") {
        json(404, { error: `proposal ${id} not found` });
        return true;
      }
      if (outcome.kind === "invalid") {
        json(400, { error: outcome.reason });
        return true;
      }
      if (outcome.kind === "decided") {
        json(409, { error: `proposal ${id} was already ${outcome.status}` });
        return true;
      }
      json(200, { id, status: outcome.status, skipped: outcome.skipped });
      return true;
    }
    if (path === "/api/memory/v2/core" && method === "POST") {
      const body = await args.readJson<{ scope?: string; text?: string; pinned?: boolean }>(
        args.req,
      );
      if (body.text === undefined || body.text.trim() === "") {
        json(400, { error: "text is required" });
        return true;
      }
      const line = await args.mind.memory.core.add({
        owner: args.owner,
        profileId: profile === undefined || profile === "owner" ? null : profile,
        scope: profile === undefined || profile === "owner" ? "owner" : "profile",
        writer: null,
        text: body.text,
        pinned: body.pinned === true,
      });
      json(200, line);
      return true;
    }
    const coreMatch = path.match(/^\/api\/memory\/v2\/core\/([^/]+)$/);
    if (coreMatch !== null) {
      const lineId = coreMatch[1] ?? "";
      if (method === "PATCH") {
        const body = await args.readJson<{ text?: string }>(args.req);
        if (body.text === undefined) {
          json(400, { error: "text is required" });
          return true;
        }
        json(
          200,
          await args.mind.memory.core.replace({
            owner: args.owner,
            profileId: profile === undefined || profile === "owner" ? null : profile,
            writer: null,
            lineId,
            text: body.text,
          }),
        );
        return true;
      }
      if (method === "DELETE") {
        await args.mind.memory.core.remove({
          owner: args.owner,
          profileId: profile === undefined || profile === "owner" ? null : profile,
          writer: null,
          lineId,
        });
        json(200, { ok: true });
        return true;
      }
    }
    return false;
  } catch (cause) {
    json(400, { error: errorOf(cause) });
    return true;
  }
}
