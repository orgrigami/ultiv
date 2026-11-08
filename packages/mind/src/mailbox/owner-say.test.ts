/**
 * The owner speaks into a bot talk: the line joins the room's transcript
 * under the owner's seat and wakes ONLY the addressed bot, framed with the
 * `[owner]` prefix the memory guard reads as the owner's voice.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "../entity.ts";
import { readView, TRANSCRIPT_WINDOW } from "../converse/view.ts";

describe("the owner speaks into a bot talk", () => {
  it("joins the transcript and wakes only the addressed bot, as the owner's voice", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const alpha = await handle.mind.profiles.create("owner", { name: "Alpha" });
    const beta = await handle.mind.profiles.create("owner", { name: "Beta" });
    const room = await handle.mind.rooms.ensure("owner", [alpha.id, beta.id], "planning");
    await handle.mind.mailbox.ownerSay({
      owner: "owner",
      room,
      to: beta.id,
      text: "Beta, where does the plan stand?",
    });
    // The line is in the room transcript, under the owner's seat.
    const lines = await handle.mind.mailbox.transcriptOf("owner", room);
    const mine = lines.find((line) => line.speakerId === "owner");
    expect(mine?.text).toBe("Beta, where does the plan stand?");
    expect(mine?.speaker).toBe("You");
    // Only the addressed bot was woken, with the owner's framing. Admission
    // is the contract (deliver.ts): offline the fresh bot's onboarding run
    // has failed, and by rule D3 nothing auto-sends after a failed run — so
    // the wake sits in the addressed bot's INBOX until its next run.
    const inboxOfMain = async (profileId: string): Promise<string> => {
      const main = await handle.mind.profiles.ensureMain("owner", profileId);
      const key = await handle.mind.profiles.keyOfRow(main);
      const chat = await Effect.runPromise(handle.mind.converse.ensure(key));
      const view = await readView(chat, TRANSCRIPT_WINDOW);
      return JSON.stringify((view.docs as Record<string, unknown>)["pi.inbox"] ?? {});
    };
    expect(await inboxOfMain(beta.id)).toContain("[owner] in the bot talk");
    expect(await inboxOfMain(beta.id)).toContain("Beta, where does the plan stand?");
    expect(await inboxOfMain(alpha.id)).not.toContain("where does the plan stand");
    await handle.close();
  });
});
