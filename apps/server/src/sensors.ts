/**
 * The sensor poll loop: the server half of the sensors faculty. Each tick it
 * walks the enabled sensors by kind: calendar sensors read the owner's ICS
 * feed (one fetch) and wake on matching events entering their lead window;
 * rss sensors fetch their own feed URL and wake on unseen items. Dedup is
 * by the FEED'S OWN natural key (ICS UID, RSS guid / Atom id — stored in a
 * ring on the sensor row), so each real-world event wakes exactly once,
 * across restarts. Sensors are low-priority wakes: they queue as follow-ups,
 * never steering a turn in flight.
 */
import { createHash } from "node:crypto";
import type { MindService } from "@spriessen/mind";
import {
  recordRoutineFire,
  readSensors,
  recordSensorFire,
  settleRoutineEvent,
  updateSensor,
  type SensorRow,
} from "@spriessen/mind";
import { calendarFeedUrl, parseFeed, parseIcs, type IcsEvent } from "@spriessen/ext";
import { deliverToSession } from "./deliver.ts";

const POLL_MS = Number(process.env.SENSOR_POLL_MS ?? 300_000);
/** The most a sensor reads from one source; past it the poll fails with an error. */
export const SENSOR_MAX_BYTES = 5 * 1024 * 1024;

/**
 * GET a source as text, refusing anything past SENSOR_MAX_BYTES (a page or
 * feed that never ends would otherwise be buffered whole in the server).
 */
export const fetchSourceText = async (url: string): Promise<string> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`returned ${response.status}`);
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > SENSOR_MAX_BYTES) {
      await reader.cancel();
      throw new Error(`response is larger than ${SENSOR_MAX_BYTES / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

/**
 * An RSS item's dedup key: the feed's own id (guid / Atom id / link), else
 * its title and publish time. The seen-check and the fire record must use
 * the SAME key, or an id-less item re-fires on every poll.
 */
export const rssUidOf = (item: {
  readonly uid: string | null;
  readonly title: string;
  readonly pubAt?: number | null;
}): string => item.uid ?? `${item.title}@${item.pubAt ?? 0}`;
/** A fire window stays open briefly past the start, so one missed poll isn't a lost wake. */
const GRACE_MS = 60 * 60 * 1000;
/** Flood cap for rss sensors: a first poll of a chatty feed wakes at most this many. */
const RSS_BATCH_CAP = 5;

export interface SensorLoop {
  readonly stop: () => void;
  /** One immediate pass (used after sensor changes and by tests). */
  readonly poll: () => Promise<void>;
}

const matches = (sensor: { match: string }, title: string): boolean =>
  sensor.match === "" || title.toLowerCase().includes(sensor.match.toLowerCase());

const markPolled = async (
  mind: MindService,
  sensor: SensorRow,
  error: string | null,
): Promise<void> => {
  if (sensor.lastError === error && sensor.lastPollAt !== null && error === null) return;
  if (error !== null && sensor.lastError === error) return;
  await updateSensor(mind.converse, sensor.id, (row) => ({
    ...row,
    lastPollAt: Date.now(),
    lastError: error,
  }));
};

/** One wake: write-ahead receipt → followUp delivery → dedup ring. */
const fire = async (
  mind: MindService,
  sensor: SensorRow,
  uid: string,
  text: string,
): Promise<void> => {
  const eventId = await recordRoutineFire(mind.converse, {
    routineId: sensor.id,
    source: "sensor",
    deliveryId: `${sensor.id}:${uid}`,
  });
  try {
    await deliverToSession(mind, sensor.sessionId, text, "followUp", "sensor");
    await settleRoutineEvent(mind.converse, eventId, "delivered");
    await recordSensorFire(mind.converse, sensor.id, uid);
  } catch (cause) {
    await settleRoutineEvent(mind.converse, eventId, "failed", String(cause).slice(0, 300));
  }
};

const pollCalendar = async (mind: MindService, sensors: readonly SensorRow[]): Promise<void> => {
  const feedUrl = calendarFeedUrl();
  if (feedUrl === null) {
    for (const sensor of sensors) {
      await markPolled(mind, sensor, "calendar feed not configured");
    }
    return;
  }
  let events: readonly IcsEvent[];
  try {
    events = parseIcs(await fetchSourceText(feedUrl));
  } catch (cause) {
    const error = String(cause).slice(0, 200);
    for (const sensor of sensors) await markPolled(mind, sensor, error);
    return;
  }
  const now = Date.now();
  for (const sensor of sensors) {
    await markPolled(mind, sensor, null);
    const due = events.filter(
      (event) =>
        matches(sensor, event.summary) &&
        !(sensor.seen ?? []).includes(event.uid ?? `${event.summary}@${event.start}`) &&
        now >= event.start - sensor.leadMinutes * 60_000 &&
        now <= event.start + GRACE_MS,
    );
    for (const event of due) {
      const uid = event.uid ?? `${event.summary}@${event.start}`;
      const at = new Date(event.start).toISOString();
      await fire(
        mind,
        sensor,
        uid,
        `[sensor ${sensor.id}] calendar: "${event.summary}" starts at ${at}` +
          (event.location !== null ? ` (${event.location})` : ""),
      );
    }
  }
};

const pollRss = async (mind: MindService, sensors: readonly SensorRow[]): Promise<void> => {
  for (const sensor of sensors) {
    if (sensor.url === null || sensor.url === "") {
      await markPolled(mind, sensor, "rss sensor has no url");
      continue;
    }
    let items: ReturnType<typeof parseFeed>;
    try {
      items = parseFeed(await fetchSourceText(sensor.url));
    } catch (cause) {
      await markPolled(mind, sensor, String(cause).slice(0, 200));
      continue;
    }
    await markPolled(mind, sensor, null);
    const due = items
      .filter(
        (item) => matches(sensor, item.title) && !(sensor.seen ?? []).includes(rssUidOf(item)),
      )
      .slice(0, RSS_BATCH_CAP);
    for (const item of due) {
      const uid = rssUidOf(item);
      await fire(
        mind,
        sensor,
        uid,
        `[sensor ${sensor.id}] rss: "${item.title}"` + (item.link !== null ? ` ${item.link}` : ""),
      );
    }
  }
};

const sensorPass = async (mind: MindService): Promise<void> => {
  const enabled = (await readSensors(mind.converse)).filter((sensor) => sensor.enabled);
  await pollCalendar(
    mind,
    enabled.filter((sensor) => sensor.kind === "calendar"),
  );
  await pollRss(
    mind,
    enabled.filter((sensor) => sensor.kind === "rss"),
  );
  await pollWatch(
    mind,
    enabled.filter((sensor) => sensor.kind === "watch"),
  );
};

/**
 * State sensors: EDGE-TRIGGERED. First poll records the baseline fingerprint
 * (never fires); each later poll fires once iff the fingerprint changed.
 * `match` filters on the raw body text — a sensor whose match text is absent
 * counts as unchanged regardless of fingerprint.
 */
const pollWatch = async (mind: MindService, sensors: readonly SensorRow[]): Promise<void> => {
  for (const sensor of sensors) {
    if (sensor.url === null || sensor.url === "") {
      await markPolled(mind, sensor, "watch sensor has no url");
      continue;
    }
    let body: string;
    try {
      body = await fetchSourceText(sensor.url);
    } catch (cause) {
      await markPolled(mind, sensor, String(cause).slice(0, 200));
      continue;
    }
    if (sensor.match !== "" && !body.toLowerCase().includes(sensor.match.toLowerCase())) {
      await markPolled(mind, sensor, null);
      continue;
    }
    const fingerprint = createHash("sha256").update(body).digest("hex").slice(0, 16);
    const previous = sensor.lastState ?? null;
    await updateSensor(mind.converse, sensor.id, (row) => ({
      ...row,
      lastPollAt: Date.now(),
      lastError: null,
      lastState: fingerprint,
    }));
    if (previous === null || previous === fingerprint) continue; // baseline or unchanged
    await fire(
      mind,
      sensor,
      `state:${fingerprint}`,
      `[sensor ${sensor.id}] watch: ${sensor.url} changed (was ${previous.slice(0, 8)}, now ${fingerprint.slice(0, 8)})`,
    );
  }
};

/** Arm the poll loop; refresh is unnecessary — sensors are read fresh each tick. */
export const startSensorLoop = async (mind: MindService): Promise<SensorLoop> => {
  // A pass that outlasts the interval (many slow sources) is not doubled:
  // two passes reading the same baseline would both fire one change.
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sensorPass(mind)
      .catch((cause) => {
        console.error("sensor poll failed:", String(cause).slice(0, 200));
      })
      .finally(() => {
        running = false;
      });
  }, POLL_MS);
  timer.unref?.();
  await sensorPass(mind).catch((cause) => {
    console.error("sensor poll failed:", String(cause).slice(0, 200));
  });
  return {
    stop: () => clearInterval(timer),
    poll: () => sensorPass(mind),
  };
};
