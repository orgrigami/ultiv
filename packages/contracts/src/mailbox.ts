import {
  arr,
  bool,
  lit,
  nul,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  type Static,
} from "@earendil-works/pi-schema";

/**
 * One inter-entity message. The lineage `chain` doubles as a trace id: one
 * cron fire fanning out across profiles correlates by it. Also the future
 * federation wire format — external senders carry `from: "external:{name}"`
 * with strictly fewer rights (no artifact grants, never autonomous).
 */
export const MailboxEnvelopeSchema = obj(
  {
    id: str(),
    /** Profile ids the message has passed through, sender first. */
    chain: arr(str()),
    from: str(),
    to: str(),
    kind: oneOf(["request", "notify", "reply", "nack"]),
    replyTo: union([str(), nul()]),
    /** The room topic this envelope belongs to (rooms are contextual). */
    topic: opt(str()),
    body: str(),
    /** Cross-profile artifact grants; internal senders only. */
    artifacts: arr(str()),
    at: num(),
  },
  { open: true },
);

export type MailboxEnvelope = Static<typeof MailboxEnvelopeSchema>;

/** One mailbox record: the envelope plus its delivery state. */
export const MailboxEntrySchema = obj(
  {
    envelope: MailboxEnvelopeSchema,
    status: union([
      lit("pending"),
      lit("replied"),
      lit("failed"),
      lit("dead"),
      /** No reply before the deadline; the sender was told. */
      lit("expired"),
      /** The owner cancelled it before the recipient started on it. */
      lit("cancelled"),
    ]),
    /** Settled turn attempts so far (re-delivery on failure, capped). */
    retries: num(),
    deliveredAt: union([num(), nul()]),
    settledAt: union([num(), nul()]),
    error: union([str(), nul()]),
    /** Owning principal (entries predate this field normalize to ""). */
    owner: opt(str()),
    /** How the send entered: tool sends are exchange-capped, deliberate ones are not. */
    origin: opt(oneOf(["tool", "human", "cron", "external"])),
    /**
     * The conversation the send was made FROM (the tunnel's near endpoint):
     * replies and NACKs are signalled back here — a session if the exchange
     * started there, otherwise the bot's main thread.
     */
    originConversation: opt(union([str(), nul()])),
    /** Epoch ms after which a still-pending message expires and the sender is told. */
    deadlineAt: opt(num()),
    /** The conversation the envelope was delivered into (fixed after the first attempt). */
    endpoint: opt(str()),
    /** The durable submission of the latest attempt, so it can be withdrawn. */
    submissionId: opt(str()),
    /** false = a finish signal or NACK is still owed to the sender (re-sent on boot). */
    senderNotified: opt(bool()),
  },
  { open: true },
);

export type MailboxEntry = Static<typeof MailboxEntrySchema>;

export const MailboxListSchema = arr(MailboxEntrySchema);

export type MailboxList = Static<typeof MailboxListSchema>;
