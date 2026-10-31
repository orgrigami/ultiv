/**
 * GET /api/needs-you — the two "Needs you" inputs the client does not
 * already poll: open memory tidy proposals per bot and recent routine
 * escalations, plus which chat each pending approval sits in (the approvals
 * list leaves that out). Read once per screen visit (and on focus), never
 * polled; the approvals and failed tasks themselves come from the existing
 * 5s polls. Also the engine's parked tasks (cut off by restarts too many
 * times in a row) for the caller's own bots, and
 * POST /api/needs-you/parked/:taskId/retry to run one again; another
 * owner's task gets the same 404 an unknown one does.
 */
import { Effect } from "effect";
import type { AuditEvent, MemoryProposal } from "@spreissen/contracts";
import { ProposalsDoc, profileKey } from "@spreissen/mind";
import type { RouteArgs } from "./types.ts";
import { visibleProposals } from "./memory-v2.ts";
import { sessionOfConversation } from "../push/events.ts";

/** How far back an escalation still counts as needing the owner. */
export const ESCALATION_WINDOW_MS = 7 * 24 * 3_600_000;
const ESCALATION_LIMIT = 20;

/** A parked engine task the caller can retry. */
export interface ParkedRow {
  taskId: string;
  kind: string;
  profile: string;
  conversationId: string;
  /** The app session (chat) it belongs to, when there is one. */
  sessionId: string | null;
}

export interface NeedsYouExtra {
  tidy: { profile: string; open: number }[];
  parked: ParkedRow[];
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
}): Omit<NeedsYouExtra, "chats" | "parked"> {
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

/** The caller's own parked tasks: a task whose conversation maps to none of their bots is not theirs. */
async function ownParked(args: RouteArgs): Promise<ParkedRow[]> {
  const rows: ParkedRow[] = [];
  for (const task of await Effect.runPromise(args.mind.converse.parked())) {
    const scope = args.mind.profiles.scopeOf(task.conversationId);
    if (scope?.owner !== args.owner) continue;
    const sessionId = await sessionOfConversation(
      args.mind,
      args.owner,
      scope.profileId,
      task.conversationId,
    ).catch(() => undefined);
    rows.push({
      taskId: task.taskId,
      kind: task.kind,
      profile: scope.profileId,
      conversationId: task.conversationId,
      sessionId: sessionId ?? null,
    });
  }
  return rows;
}

const RETRY_PATH = /^\/api\/needs-you\/parked\/([^/]+)\/retry$/;

export async function needsYouRoutes(args: RouteArgs): Promise<boolean> {
  const retry = args.path.match(RETRY_PATH);
  if (retry !== null && args.req.method === "POST") {
    const taskId = decodeURIComponent(retry[1] ?? "");
    const mine = (await ownParked(args)).some((row) => row.taskId === taskId);
    if (!mine) {
      args.json(404, { error: "unknown parked task" });
      return true;
    }
    const outcome = await Effect.runPromise(args.mind.converse.retryParked(taskId));
    args.json(outcome === "retried" ? 200 : 404, { outcome });
    return true;
  }
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
    if (scope?.owner !== args.owner || chats[entry.conversationId] !== undefined) continue;
    const sessionId = await sessionOfConversation(
      args.mind,
      args.owner,
      scope.profileId,
      entry.conversationId,
    ).catch(() => undefined);
    if (sessionId !== undefined) chats[entry.conversationId] = sessionId;
  }
  const body: NeedsYouExtra = {
    ...needsYouExtra({
      proposals,
      audit: args.mind.audit.tail(5_000),
      profiles: new Set(profiles.map((profile) => profile.id)),
      now: Date.now(),
    }),
    chats,
    parked: await ownParked(args),
  };
  args.json(200, body);
  return true;
}
