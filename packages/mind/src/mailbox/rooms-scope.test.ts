import { expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { openMind } from "../entity.ts";
import { mailboxService } from "./mailbox.ts";

process.env.MAILBOX_WAKE_DEBOUNCE_MS = "20";

import { messageTools } from "./tools.ts";

const setup = async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { converse, profiles, rooms, audit } = handle.mind;
  const mailbox = mailboxService({
    converse,
    profiles,
    rooms,
    audit,
    options: { retryDelayMs: 0 },
  });
  const a = await profiles.create("harry", { name: "One", onboard: false });
  const b = await profiles.create("harry", { name: "Two", onboard: false });
  const mainOf = async (id: string) =>
    Effect.runPromise(
      converse.ensure(await profiles.keyOfRow(await profiles.ensureMain("harry", id))),
    );
  return { handle, mailbox, profiles, rooms, a, b, mainOf };
};

const send = (
  mailbox: ReturnType<typeof mailboxService>,
  from: string,
  to: string,
  body: string,
  topic?: string,
) =>
  mailbox.send({
    owner: "harry",
    from,
    to,
    kind: "notify",
    body,
    origin: "tool",
    ...(topic === undefined ? {} : { topic }),
  });

const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

it("the room tool reads only rooms the calling bot sits in", async () => {
  const { handle, mailbox, profiles, rooms, a, b, mainOf } = await setup();
  const c = await profiles.create("harry", { name: "Three", onboard: false });
  await send(mailbox, a.id, b.id, "private to Two");
  await pause();
  const room = (await rooms.list("harry", a.id))[0];
  expect(room).toBeDefined();
  const roomTool = messageTools(mailbox, profiles, rooms).find((tool) => tool.name === "room");
  const asThree = await roomTool!.execute(
    { room: room!.id },
    { conversationId: (await mainOf(c.id)).id } as never,
    undefined as never,
  );
  expect(JSON.stringify(asThree)).not.toContain("private to Two");
  expect(JSON.stringify(asThree)).toContain("no such room");
  const asOne = await roomTool!.execute(
    { room: room!.id },
    { conversationId: (await mainOf(a.id)).id } as never,
    undefined as never,
  );
  expect(JSON.stringify(asOne)).toContain("private to Two");
  await handle.close();
});

it("a topic past the room cap still lands in its room's transcript", async () => {
  const { handle, mailbox, rooms, a, b } = await setup();
  const topic = `  ${"q".repeat(260)}  `;
  await send(mailbox, a.id, b.id, "long-topic body", topic);
  await pause();
  const room = (await rooms.list("harry", a.id))[0];
  expect(room?.topic.length).toBe(200);
  const lines = await mailbox.transcriptOf("harry", room!);
  expect(lines.map((line) => line.text)).toContain("long-topic body");
  expect(lines[0]?.speakerId).toBe(a.id);
  await handle.close();
});

it("signals every committed change to listeners until they unsubscribe", async () => {
  const { handle, mailbox, a, b } = await setup();
  let heard = 0;
  const off = mailbox.listen(() => {
    heard += 1;
  });
  await send(mailbox, a.id, b.id, "ping");
  await pause();
  expect(heard).toBeGreaterThanOrEqual(1);
  off();
  const before = heard;
  await send(mailbox, a.id, b.id, "pong");
  await pause();
  expect(heard).toBe(before);
  await handle.close();
});
