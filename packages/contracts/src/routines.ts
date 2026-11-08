import { arr, nul, num, obj, oneOf, str, union, type Static } from "@earendil-works/pi-schema";

/**
 * One Routine fire receipt — the durable evidence that a trigger FIRED,
 * written before delivery (write-ahead) and updated with the outcome. Cron
 * fires, webhook ingress and webhook test-fires all land here, so "did it
 * run?" is always answerable even when the delivery itself vanished.
 */
export const RoutineEventSchema = obj(
  {
    id: str(),
    /** The cron job or webhook this receipt belongs to. */
    routineId: str(),
    /** Which trigger family fired: a schedule, an inbound webhook, a sensor, or a test fire. */
    source: oneOf(["cron", "webhook", "sensor", "test"]),
    /** Wall-clock ms when the trigger fired. */
    at: num(),
    /** Correlation handle handed back to webhook senders in the ack body. */
    deliveryId: str(),
    /**
     * accepted = durably recorded, delivery pending (the write-ahead state —
     * a receipt stuck here after a crash is a visible incomplete pair);
     * delivered = admitted into the session conversation; failed = delivery
     * exhausted its retries; rejected = ingress refused (auth/schema/rate/size);
     * trial = the fire ran as a trial (every action held back, nothing woken);
     * ignored = a webhook sender not on its allow list, with no chat to add
     * context to (nothing woken).
     */
    status: oneOf(["accepted", "delivered", "failed", "rejected", "trial", "ignored"]),
    /** Rejection class or failure reason; null when nothing went wrong. */
    reason: union([str(), nul()]),
  },
  { open: true },
);

export type RoutineEvent = Static<typeof RoutineEventSchema>;

export const RoutineEventListSchema = arr(RoutineEventSchema);

export type RoutineEventList = Static<typeof RoutineEventListSchema>;
