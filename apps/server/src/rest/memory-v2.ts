/**
 * Memory v2 REST: the human surface over the facts/core/proposals docs —
 * the owner reads and decides, the tidy proposes. Owner-scoped via
 * `x-ultiv-user` like every route. Purge is irreversible and human-only.
 */
import { Effect } from "effect";
import type { MemoryProposal } from "@ultiv/contracts";
import { FactsDoc, ProposalsDoc, ownerKey, profileKey } from "@ultiv/mind";
import { errorOf, type RouteArgs } from "./types.ts";
import { runTidy } from "../memory-tidy.ts";

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
    entities,
    core: { owner: ownerCore, profile: profileCore },
    proposals: visible.sort((a, b) => b.at - a.at),
    openCount: visible.filter((proposal) => proposal.status === "open").length,
  };
};

/** Apply an accepted proposal — the ONLY place proposals change facts. */
const applyProposal = async (
  args: RouteArgs,
  proposal: MemoryProposal,
  profile: string | undefined,
): Promise<void> => {
  const key = keyOf(args.owner, profile);
  const setStatus = async (ids: readonly string[], status: "archived" | "forgotten") => {
    for (const factId of ids) {
      if (factId === undefined) continue;
      await run(
        args.mind.converse.docs.commit(async (tx) => {
          const store = await tx.doc(FactsDoc, key, { facts: [], migratedAt: null });
          store.facts = store.facts.map((fact) =>
            fact.id === factId ? { ...fact, status, expiredAt: Date.now() } : fact,
          );
        }),
      );
    }
  };
  if (proposal.kind === "archive" || proposal.kind === "stale") {
    await setStatus(proposal.factIds, "archived");
    return;
  }
  if (proposal.kind === "merge") {
    // The first id survives; the rest become its history.
    const [primary, ...others] = proposal.factIds;
    if (primary === undefined) return;
    for (const factId of others) {
      if (factId === undefined) continue;
      await run(
        args.mind.converse.docs.commit(async (tx) => {
          const store = await tx.doc(FactsDoc, key, { facts: [], migratedAt: null });
          store.facts = store.facts.map((fact) =>
            fact.id === factId
              ? {
                  ...fact,
                  status: "superseded" as const,
                  supersededBy: primary,
                  expiredAt: Date.now(),
                }
              : fact,
          );
        }),
      );
    }
    return;
  }
  if (proposal.kind === "secret" || proposal.kind === "conflict") {
    await setStatus(proposal.factIds, "forgotten");
  }
  // core-fix, entity-merge, backfill: record-only accepts need no fact change.
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
  try {
    if (path === "/api/memory/v2" && method === "GET") {
      json(200, await readStore(args, profile));
      return true;
    }
    if (path === "/api/memory/tidy/run" && method === "POST") {
      const push = args.push;
      const result = await runTidy(
        {
          mind: args.mind,
          ...(push !== undefined
            ? {
                notify: (owner, text) =>
                  push.notifier
                    .notify(owner, {
                      title: text,
                      body: "Open the Memory panel to review.",
                      url: "/bots",
                      tag: "memory-tidy",
                    })
                    .then(() => undefined),
              }
            : {}),
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
      await args.mind.memory.restore(
        args.owner,
        profile === undefined || profile === "owner" ? null : profile,
        restoreMatch[1] ?? "",
      );
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
    if (proposalMatch !== null && method === "POST") {
      const [, id, verdict] = proposalMatch;
      const key = keyOf(args.owner, profile);
      const store = await run(args.mind.converse.docs.snapshotKeyed(ProposalsDoc, key)).then(
        (draft) => draft?.proposals ?? [],
      );
      const proposal = store.find((entry) => entry.id === id);
      if (proposal === undefined) {
        json(404, { error: `proposal ${id} not found` });
        return true;
      }
      if (verdict === "accept") await applyProposal(args, proposal, profile);
      const status: MemoryProposal["status"] = verdict === "accept" ? "accepted" : "rejected";
      await run(
        args.mind.converse.docs.commit(async (tx) => {
          const draft = await tx.doc(ProposalsDoc, key, { proposals: [] });
          draft.proposals = draft.proposals.map((entry) =>
            entry.id === id ? { ...entry, status, decidedAt: Date.now() } : entry,
          );
        }),
      );
      json(200, { id, status });
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
