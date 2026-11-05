/**
 * GET /api/needs-you — the two "Needs you" inputs the client does not
 * already poll: open memory tidy proposals per bot and recent routine
 * escalations, plus which chat each pending approval sits in (the approvals
 * list leaves that out). Read once per screen visit (and on focus), never
 * polled; the approvals and failed tasks themselves come from the existing
 * 5s polls.
 */
import { Effect } from "effect";
import type { AuditEvent, MemoryProposal } from "@spriessen/contracts";
import { ProposalsDoc, profileKey } from "@spriessen/mind";
import type { RouteArgs } from "./types.ts";
import { can } from "./can.ts";
import { visibleProposals } from "./memory-v2.ts";
import { sessionOfConversation } from "../push/events.ts";

/** How far back an escalation still counts as needing the owner. */
export const ESCALATION_WINDOW_MS = 7 * 24 * 3_600_000;
const ESCALATION_LIMIT = 20;

export interface NeedsYouExtra {
  tidy: { profile: string; open: number }[];
  escalations: AuditEvent[];
  /** Pending approval conversation id -> the app session (chat) it shows in. */
  chats: Record<string, string>;
}

/** Pure: fold per-bot proposals and the audit tail into the response. */
export function needsYouExtra(input: {
  proposals: ReadonlyMap<string, readonly MemoryProposal[]>;
  audit: readonly AuditEvent[];
  profiles: ReadonlySet<string>;
  now: number;
}): Omit<NeedsYouExtra, "chats"> {
  const tidy = [...input.proposals]
    .map(([profile, proposals]) => ({
      profile,
      open: visibleProposals(proposals, input.now).filter((p) => p.status === "open").length,
    }))
    .filter((row) => row.open > 0);
  const escalations = input.audit
    .filter(
      (event) =>
        event.kind === "escalation" &&
        event.profile !== null &&
        input.profiles.has(event.profile) &&
        input.now - event.at <= ESCALATION_WINDOW_MS,
    )
    .slice(-ESCALATION_LIMIT)
    .reverse();
  return { tidy, escalations };
}

export async function needsYouRoutes(args: RouteArgs): Promise<boolean> {
  if (args.path !== "/api/needs-you" || args.req.method !== "GET") return false;
  const profiles = (await args.mind.profiles.list(args.owner)).filter(
    (profile) => profile.archivedAt === null,
  );
  const proposals = new Map<string, readonly MemoryProposal[]>();
  await Promise.all(
    profiles.map(async (profile) => {
      const store = await Effect.runPromise(
        args.mind.converse.docs.snapshotKeyed(ProposalsDoc, profileKey(args.owner, profile.id)),
      );
      proposals.set(profile.id, store?.proposals ?? []);
    }),
  );
  const chats: Record<string, string> = {};
  for (const entry of args.mind.approvals.pendingAll()) {
    const scope = args.mind.profiles.scopeOf(entry.conversationId);
    if (
      scope === undefined ||
      !can(args.owner, "view", { type: "chat", owner: scope.owner, id: entry.conversationId }) ||
      chats[entry.conversationId] !== undefined
    ) {
      continue;
    }
    const sessionId = await sessionOfConversation(
      args.mind,
      args.owner,
      scope.profileId,
      entry.conversationId,
    ).catch(() => undefined);
    if (sessionId !== undefined) chats[entry.conversationId] = sessionId;
  }
  const mine = new Set(profiles.map((profile) => profile.id));
  const body: NeedsYouExtra = {
    ...needsYouExtra({
      proposals,
      // This owner's escalations of the window, however much came after.
      audit: args.mind.audit.find(
        (event) => event.kind === "escalation" && event.profile !== null && mine.has(event.profile),
        { limit: ESCALATION_LIMIT, since: Date.now() - ESCALATION_WINDOW_MS },
      ),
      profiles: mine,
      now: Date.now(),
    }),
    chats,
  };
  args.json(200, body);
  return true;
}
