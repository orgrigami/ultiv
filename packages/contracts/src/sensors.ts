import {
  arr,
  bool,
  nul,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  type Static,
} from "@earendil-works/pi-schema";
import { RoutineTrialSchema } from "./routine-trial.ts";

/**
 * One sensor: a watch on an external source (calendar feeds, RSS/Atom
 * feeds, and raw-URL state watches today) that wakes the entity on events.
 * Event sensors (calendar, rss) dedup by the SOURCE's natural key (ICS UID,
 * guid / Atom id). State sensors (watch) are EDGE-TRIGGERED instead: they
 * store the last known fingerprint and fire on its transition — the
 * threshold shape, where "new id" doesn't exist.
 */
export const SensorInfoSchema = obj(
  {
    id: str(),
    sessionId: str(),
    profile: str(),
    /** "calendar" owner ICS · "rss" own feed · "watch" url fingerprint transitions. */
    kind: oneOf(["calendar", "rss", "watch"]),
    /** For rss/watch sensors: the polled URL (http/https). Null for calendar. */
    url: union([str(), nul()]),
    /** Case-insensitive substring the item title must contain; empty matches everything. */
    match: str(),
    /** Calendar sensors: wake this many minutes before the event starts. */
    leadMinutes: num(),
    enabled: bool(),
    createdAt: num(),
    lastPollAt: union([num(), nul()]),
    lastError: union([str(), nul()]),
    fireCount: num(),
    lastFiredAt: union([num(), nul()]),
    /** Dedup ring: recent source event uids already woken on (event sensors). */
    seen: opt(arr(str())),
    /** State sensors: fingerprint of the last seen body — fire on its transition. */
    lastState: opt(union([str(), nul()])),
    /** Trial mode (routine-trial.ts): each event runs as a trial until turned live. */
    trial: opt(bool()),
    /** The latest trials, oldest first (at most TRIALS_KEPT). */
    trials: opt(arr(RoutineTrialSchema)),
  },
  { open: true },
);

export type SensorInfo = Static<typeof SensorInfoSchema>;

export const SensorListSchema = arr(SensorInfoSchema);

export type SensorList = Static<typeof SensorListSchema>;
