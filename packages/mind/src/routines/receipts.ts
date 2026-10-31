/**
 * Routine fire receipts: the durable ledger that a trigger FIRED. Written
 * write-ahead — a receipt is recorded BEFORE its delivery is attempted, then
 * updated with the outcome — so a crash mid-flight shows up as a receipt
 * stuck in "accepted" (a visible incomplete pair) instead of silence. Cron
 * fires, webhook ingress and webhook test-fires all land here. The log is
 * bounded: oldest receipts fall off the front.
 */
import { randomUUID } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { RoutineEvent, RoutineEventList } from "@spreissen/contracts";
import type { ConverseService } from "../converse/converse.ts";

/** Oldest receipts fall off once the log passes this length. */
export const ROUTINE_EVENT_CAP = 400;

export const RoutineEventsDoc = defineDoc<{ items: RoutineEvent[] }>({
  kind: "ultiv.routine-events",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});

const readEvents = async (converse: ConverseService): Promise<RoutineEvent[]> =>
  (await Effect.runPromise(converse.docs.snapshot(RoutineEventsDoc)))?.items ?? [];

/**
 * WRITE-AHEAD: record that a routine fired BEFORE acting on it. Returns the
 * receipt id (which doubles as the webhook ack's correlation handle).
 */
export const recordRoutineFire = async (
  converse: ConverseService,
  input: {
    routineId: string;
    source: RoutineEvent["source"];
    deliveryId?: string;
    reason?: string | null;
  },
): Promise<string> => {
  const id = input.deliveryId ?? randomUUID();
  const event: RoutineEvent = {
    id,
    routineId: input.routineId,
    source: input.source,
    at: Date.now(),
    deliveryId: id,
    status: "accepted",
    reason: input.reason ?? null,
  };
  await Effect.runPromise(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(RoutineEventsDoc);
      draft.items = [event, ...draft.items].slice(0, ROUTINE_EVENT_CAP);
    }),
  );
  return id;
};

/** Settle a write-ahead receipt into its final state. */
export const settleRoutineEvent = async (
  converse: ConverseService,
  id: string,
  status: Exclude<RoutineEvent["status"], "accepted">,
  reason?: string | null,
): Promise<void> => {
  await Effect.runPromise(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(RoutineEventsDoc);
      draft.items = draft.items.map((event) =>
        event.id === id ? { ...event, status, reason: reason ?? event.reason } : event,
      );
    }),
  );
};

/** The receipt tail, newest first; filter by routine and/or source. */
export const listRoutineEvents = async (
  converse: ConverseService,
  filter: {
    routineId?: string;
    source?: RoutineEvent["source"];
    limit?: number;
  } = {},
): Promise<RoutineEventList> => {
  const items = await readEvents(converse);
  return items
    .filter(
      (event) =>
        (filter.routineId === undefined || event.routineId === filter.routineId) &&
        (filter.source === undefined || event.source === filter.source),
    )
    .slice(0, filter.limit ?? 100);
};

/** Rejections of one routine in the last 24h — the key-rotation alarm. */
export const rejectsLast24h = async (
  converse: ConverseService,
  routineId: string,
): Promise<number> => {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const items = await readEvents(converse);
  return items.filter(
    (event) => event.routineId === routineId && event.status === "rejected" && event.at >= since,
  ).length;
};

export interface ReceiptsService {
  readonly record: (input: {
    routineId: string;
    source: RoutineEvent["source"];
    deliveryId?: string;
    reason?: string | null;
  }) => Promise<string>;
  readonly settle: (
    id: string,
    status: Exclude<RoutineEvent["status"], "accepted">,
    reason?: string | null,
  ) => Promise<void>;
  readonly list: (filter?: {
    routineId?: string;
    source?: RoutineEvent["source"];
    limit?: number;
  }) => Promise<RoutineEventList>;
  readonly rejectsLast24h: (routineId: string) => Promise<number>;
}

export const receiptsService = (deps: { readonly converse: ConverseService }): ReceiptsService => ({
  record: (input) => recordRoutineFire(deps.converse, input),
  settle: (id, status, reason) => settleRoutineEvent(deps.converse, id, status, reason),
  list: (filter) => listRoutineEvents(deps.converse, filter),
  rejectsLast24h: (routineId) => rejectsLast24h(deps.converse, routineId),
});
