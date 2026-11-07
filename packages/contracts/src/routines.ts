import { Type, type Static } from "typebox";

/**
 * One Routine fire receipt — the durable evidence that a trigger FIRED,
 * written before delivery (write-ahead) and updated with the outcome. Cron
 * fires, webhook ingress and webhook test-fires all land here, so "did it
 * run?" is always answerable even when the delivery itself vanished.
 */
export const RoutineEventSchema = Type.Object({
  id: Type.String(),
  /** The cron job or webhook this receipt belongs to. */
  routineId: Type.String(),
  /** Which trigger family fired: a schedule, an inbound webhook, a sensor, or a test fire. */
  source: Type.Union([
    Type.Literal("cron"),
    Type.Literal("webhook"),
    Type.Literal("sensor"),
    Type.Literal("test"),
  ]),
  /** Wall-clock ms when the trigger fired. */
  at: Type.Number(),
  /** Correlation handle handed back to webhook senders in the ack body. */
  deliveryId: Type.String(),
  /**
   * accepted = durably recorded, delivery pending (the write-ahead state —
   * a receipt stuck here after a crash is a visible incomplete pair);
   * delivered = admitted into the session conversation; failed = delivery
   * exhausted its retries; rejected = ingress refused (auth/schema/rate/size);
   * trial = the fire ran as a trial (every action held back, nothing woken).
   */
  status: Type.Union([
    Type.Literal("accepted"),
    Type.Literal("delivered"),
    Type.Literal("failed"),
    Type.Literal("rejected"),
    Type.Literal("trial"),
  ]),
  /** Rejection class or failure reason; null when nothing went wrong. */
  reason: Type.Union([Type.String(), Type.Null()]),
});

export type RoutineEvent = Static<typeof RoutineEventSchema>;

export const RoutineEventListSchema = Type.Array(RoutineEventSchema);

export type RoutineEventList = Static<typeof RoutineEventListSchema>;
