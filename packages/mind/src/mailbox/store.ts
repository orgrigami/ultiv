/**
 * The mailbox's durable state: the `ultiv.mailbox` doc and atomic
 * read-modify-write helpers over it, plus the counting lanes that bound how
 * many deliveries run at once.
 */
import { defineDoc } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { MailboxEntry } from "@spreissen/contracts";
import type { ConverseService } from "../converse/converse.ts";

export const MailboxDoc = defineDoc<{ items: MailboxEntry[] }>({
  kind: "ultiv.mailbox",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});

export const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

export const isExternal = (id: string): boolean => id.startsWith("external:");

/** Legacy rows predate owner/origin/topic; normalize on every read. */
const normalize = (entry: MailboxEntry): MailboxEntry => ({
  ...entry,
  owner: entry.owner ?? "",
  origin: entry.origin ?? "tool",
  envelope: { ...entry.envelope, topic: entry.envelope.topic ?? "" },
});

export const readEntries = (converse: ConverseService): Promise<MailboxEntry[]> =>
  run(converse.docs.snapshot(MailboxDoc)).then((doc) => (doc?.items ?? []).map(normalize));

export const findEntry = (
  converse: ConverseService,
  id: string,
): Promise<MailboxEntry | undefined> =>
  readEntries(converse).then((entries) => entries.find((entry) => entry.envelope.id === id));

export const writeEntries = (
  converse: ConverseService,
  change: (items: MailboxEntry[]) => MailboxEntry[],
): Promise<void> =>
  run(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(MailboxDoc);
      draft.items = change(draft.items);
    }),
  );

export type EntryPatch = Partial<
  Pick<
    MailboxEntry,
    | "status"
    | "retries"
    | "deliveredAt"
    | "settledAt"
    | "error"
    | "deadlineAt"
    | "endpoint"
    | "submissionId"
    | "senderNotified"
  >
>;

/** Patch one entry unconditionally. */
export const updateEntry = (
  converse: ConverseService,
  id: string,
  patch: EntryPatch,
): Promise<void> =>
  writeEntries(converse, (items) =>
    items.map((entry) => (entry.envelope.id === id ? { ...entry, ...patch } : entry)),
  );

/**
 * Patch one entry only while it is still pending, atomically: a late turn
 * never overwrites an expiry or a cancellation. Returns the patched entry,
 * or undefined when the entry was gone or already settled.
 */
export const updatePending = (
  converse: ConverseService,
  id: string,
  patch: EntryPatch,
): Promise<MailboxEntry | undefined> =>
  run(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(MailboxDoc);
      let patched: MailboxEntry | undefined;
      draft.items = draft.items.map((entry) => {
        if (entry.envelope.id !== id || entry.status !== "pending") return entry;
        patched = { ...entry, ...patch };
        return patched;
      });
      // A plain copy: draft objects must not escape the transaction.
      return patched === undefined
        ? undefined
        : normalize(JSON.parse(JSON.stringify(patched)) as MailboxEntry);
    }),
  );

/** A counting lane: N holders at once, everyone else waits in FIFO order. */
export class Lane {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
  readonly acquire = (): Promise<() => void> =>
    new Promise((resolve) => {
      const release = (): void => {
        this.active -= 1;
        const next = this.waiting.shift();
        if (next !== undefined) next();
      };
      if (this.active < this.cap) {
        this.active += 1;
        resolve(release);
      } else {
        this.waiting.push(() => {
          this.active += 1;
          resolve(release);
        });
      }
    });
}
