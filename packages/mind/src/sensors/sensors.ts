/**
 * The sensors faculty: watches on external sources that wake the entity —
 * calendar feeds first. A sensor carries its own DEDUP RING of source event
 * uids: the natural key from the outside system, so the harness dedups at
 * the semantic layer and each real-world event wakes the entity once. The
 * poll loop itself lives on the server (it needs the clock and the network);
 * this is the durable registry + CRUD + the fire bookkeeping.
 */
import { randomUUID } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { SensorInfo, SensorList } from "@spreissen/contracts";
import type { ConverseService } from "../converse/converse.ts";

/** Seen-uid ring size per sensor — uids older than this can re-fire (harmless: long past). */
const SEEN_CAP = 200;

/** A stored sensor row = the public info + the dedup ring. */
export type SensorRow = SensorInfo;

export const SensorsDoc = defineDoc<{ items: SensorRow[] }>({
  kind: "ultiv.sensors",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});

const normalize = (row: SensorRow): SensorRow => ({
  ...row,
  profile: row.profile ?? "default",
  seen: row.seen ?? [],
  fireCount: row.fireCount ?? 0,
  lastPollAt: row.lastPollAt ?? null,
  lastFiredAt: row.lastFiredAt ?? null,
  lastError: row.lastError ?? null,
});
export const readSensors = async (converse: ConverseService): Promise<SensorRow[]> =>
  ((await Effect.runPromise(converse.docs.snapshot(SensorsDoc)))?.items ?? []).map(normalize);

const writeSensors = (converse: ConverseService, items: SensorRow[]) =>
  converse.docs.commit(async (tx) => {
    const draft = await tx.doc(SensorsDoc);
    draft.items = items;
  });

export const listSensors = async (converse: ConverseService): Promise<SensorList> =>
  (await readSensors(converse)).map(({ seen: _seen, ...info }) => info);

/** Functional update of one sensor row (poll bookkeeping, seen-ring growth). */
export const updateSensor = async (
  converse: ConverseService,
  id: string,
  update: (row: SensorRow) => SensorRow,
): Promise<void> => {
  await Effect.runPromise(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(SensorsDoc);
      draft.items = draft.items.map((row) => (row.id === id ? update(normalize(row)) : row));
    }),
  );
};

/** Record one fired event uid (the dedup ring) + bump the fire receipts. */
export const recordSensorFire = async (
  converse: ConverseService,
  id: string,
  uid: string,
): Promise<void> => {
  await updateSensor(converse, id, (row) => ({
    ...row,
    seen: [...(row.seen ?? []), uid].slice(-SEEN_CAP),
    fireCount: row.fireCount + 1,
    lastFiredAt: Date.now(),
  }));
};

export interface SensorCreate {
  readonly sessionId: string;
  readonly kind?: "calendar" | "rss" | "watch";
  /** rss/watch sensors: the polled URL (http/https required). */
  readonly url?: string;
  readonly match: string;
  readonly leadMinutes?: number;
}

export const createSensor = async (
  converse: ConverseService,
  profiles: { rowOf: (sessionId: string) => Promise<{ profile: string } | undefined> },
  input: SensorCreate,
): Promise<SensorInfo> => {
  const kind = input.kind ?? "calendar";
  let url: string | null = null;
  if (kind === "rss" || kind === "watch") {
    url = input.url ?? "";
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
    } catch {
      throw new Error(`${kind} sensors need a valid http(s) url`);
    }
  }
  const row = await profiles.rowOf(input.sessionId);
  const sensor: SensorRow = {
    id: randomUUID(),
    sessionId: input.sessionId,
    profile: row?.profile ?? "default",
    kind,
    url,
    match: input.match,
    leadMinutes: Math.min(Math.max(input.leadMinutes ?? 10, 0), 24 * 60),
    enabled: true,
    createdAt: Date.now(),
    lastPollAt: null,
    lastError: null,
    fireCount: 0,
    lastFiredAt: null,
    seen: [],
    lastState: null,
  };
  await Effect.runPromise(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(SensorsDoc);
      draft.items = [...draft.items, sensor];
    }),
  );
  const { seen: _seen, ...info } = sensor;
  return info;
};

export const removeSensor = async (converse: ConverseService, id: string): Promise<boolean> => {
  const before = await readSensors(converse);
  const remaining = before.filter((sensor) => sensor.id !== id);
  if (remaining.length === before.length) return false;
  await Effect.runPromise(writeSensors(converse, remaining));
  return true;
};

/** Remove every sensor bound to one of the given sessions (profile purge cascade). */
export const removeSensorsForSessions = async (
  converse: ConverseService,
  sessionIds: readonly string[],
): Promise<number> => {
  const bound = new Set(sessionIds);
  const before = await readSensors(converse);
  const remaining = before.filter((sensor) => !bound.has(sensor.sessionId));
  if (remaining.length !== before.length)
    await Effect.runPromise(writeSensors(converse, remaining));
  return before.length - remaining.length;
};

export interface SensorsService {
  readonly list: () => Promise<SensorList>;
  readonly create: (input: SensorCreate) => Promise<SensorInfo>;
  readonly remove: (id: string) => Promise<boolean>;
  readonly removeForSessions: (sessionIds: readonly string[]) => Promise<number>;
}

export const sensorsService = (deps: {
  readonly converse: ConverseService;
  readonly profiles: { rowOf: (sessionId: string) => Promise<{ profile: string } | undefined> };
}): SensorsService => ({
  list: () => listSensors(deps.converse),
  create: (input) => createSensor(deps.converse, deps.profiles, input),
  remove: (id) => removeSensor(deps.converse, id),
  removeForSessions: (sessionIds) => removeSensorsForSessions(deps.converse, sessionIds),
});
