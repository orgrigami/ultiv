import { Type, type Static } from "typebox";
import { RoutineTrialSchema } from "./routine-trial.ts";

/**
 * One sensor: a watch on an external source (calendar feeds, RSS/Atom
 * feeds, and raw-URL state watches today) that wakes the entity on events.
 * Event sensors (calendar, rss) dedup by the SOURCE's natural key (ICS UID,
 * guid / Atom id). State sensors (watch) are EDGE-TRIGGERED instead: they
 * store the last known fingerprint and fire on its transition — the
 * threshold shape, where "new id" doesn't exist.
 */
export const SensorInfoSchema = Type.Object({
  id: Type.String(),
  sessionId: Type.String(),
  profile: Type.String(),
  /** "calendar" owner ICS · "rss" own feed · "watch" url fingerprint transitions. */
  kind: Type.Union([Type.Literal("calendar"), Type.Literal("rss"), Type.Literal("watch")]),
  /** For rss/watch sensors: the polled URL (http/https). Null for calendar. */
  url: Type.Union([Type.String(), Type.Null()]),
  /** Case-insensitive substring the item title must contain; empty matches everything. */
  match: Type.String(),
  /** Calendar sensors: wake this many minutes before the event starts. */
  leadMinutes: Type.Number(),
  enabled: Type.Boolean(),
  createdAt: Type.Number(),
  lastPollAt: Type.Union([Type.Number(), Type.Null()]),
  lastError: Type.Union([Type.String(), Type.Null()]),
  fireCount: Type.Number(),
  lastFiredAt: Type.Union([Type.Number(), Type.Null()]),
  /** Dedup ring: recent source event uids already woken on (event sensors). */
  seen: Type.Optional(Type.Array(Type.String())),
  /** State sensors: fingerprint of the last seen body — fire on its transition. */
  lastState: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** Trial mode (routine-trial.ts): each event runs as a trial until turned live. */
  trial: Type.Optional(Type.Boolean()),
  /** The latest trials, oldest first (at most TRIALS_KEPT). */
  trials: Type.Optional(Type.Array(RoutineTrialSchema)),
});

export type SensorInfo = Static<typeof SensorInfoSchema>;

export const SensorListSchema = Type.Array(SensorInfoSchema);

export type SensorList = Static<typeof SensorListSchema>;
