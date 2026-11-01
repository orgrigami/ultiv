/**
 * Per-bot Linux users inside the VMs (phase 4 slice 2b). Every bot that runs
 * `bash` in its home's VM (or, later, any VM) works as its own Linux user:
 * a fixed uid from 10000 up, the SAME uid in every VM, never reused for
 * another bot. Allocation lives in the `ultiv.bot-uids` ledger document —
 * rows are kept even after a bot is removed, so uids are never handed out
 * twice. The Linux user itself is provisioned idempotently inside each VM
 * (ext, `botProvisionScript`) on the bot's first use there; this module only
 * decides WHO the bot is.
 */
import { defineDoc } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { botFolderName, scopeHash } from "@spriessen/ext";
import type { ConverseService } from "../converse/converse.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

/** The uid ledger: `nextUid` plus one kept-forever row per bot. */
export const BotUidsDoc = defineDoc<{ nextUid: number; byBot: Record<string, number> }>({
  kind: "ultiv.bot-uids",
  version: 1,
  scope: "session",
  initial: () => ({ nextUid: 10_000, byBot: {} }),
  checkpointWhen: () => true,
});

/** The bot's Linux identity inside a VM (ext's `SandboxUser` shape). */
export interface BotUser {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
}

/** The first uid a bot gets (uid 1000 is the image's `node` user). */
export const FIRST_BOT_UID = 10_000;

/**
 * The Linux user name for one bot: `bot-` plus a short stable hash — a
 * profile id is a UUID (far over useradd's 32-byte name limit), and two bots
 * must never collide after truncation, so no part of the id is kept verbatim.
 */
export const botUserName = (profileId: string): string => `bot-${scopeHash(profileId)}`;

/** The bot's uid: allocated once from 10000 up, then stable forever. */
export const botUidOf =
  (converse: ConverseService) =>
  (profileId: string): Promise<number> =>
    run(
      converse.docs.commit(async (tx) => {
        const draft = await tx.doc(BotUidsDoc);
        const existing = draft.byBot[profileId];
        if (existing !== undefined) return existing;
        const uid = draft.nextUid;
        draft.nextUid = uid + 1;
        draft.byBot[profileId] = uid;
        return uid;
      }),
    );

/** The bot's uid when one was already allocated; never allocates. */
export const botUidPeek =
  (converse: ConverseService) =>
  (profileId: string): Promise<number | undefined> =>
    run(Effect.map(converse.docs.snapshot(BotUidsDoc), (doc) => doc?.byBot[profileId]));

/**
 * The bot's full Linux identity: name, uid (allocating on first use — this
 * is "first use in a VM"), own group (gid = uid; where a VM already uses that
 * gid for its shared folder the user simply joins that group), and the bot's
 * home folder inside the VM — the same folder `prepare` fills.
 */
export const botUserOf =
  (converse: ConverseService) =>
  (root: string, owner: string, profileId: string): Promise<BotUser> =>
    botUidOf(converse)(profileId).then((uid) => ({
      name: botUserName(profileId),
      uid,
      gid: uid,
      home: `/home/${botFolderName(`${root}/${owner}/${profileId}`)}`,
    }));
