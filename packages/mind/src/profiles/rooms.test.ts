import { expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "../entity.ts";

it("purging one owner's bot keeps every other owner's rooms", async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { rooms } = handle.mind;
  await rooms.ensure("alice", ["a1", "a2"], "plans");
  await rooms.ensure("alice", ["a2", "a3"], "other");
  await rooms.ensure("bob", ["b1", "b2"], "plans");
  expect(await rooms.purgeProfile("alice", "a1")).toBe(1);
  expect((await rooms.list("alice")).map((room) => room.topic)).toEqual(["other"]);
  expect(await rooms.list("bob")).toHaveLength(1);
  await handle.close();
});

it("racing ensures for a new pair and topic create one room", async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { rooms } = handle.mind;
  const made = await Promise.all(
    Array.from({ length: 5 }, () => rooms.ensure("alice", ["x", "y"], " launch ")),
  );
  expect(new Set(made.map((room) => room.id)).size).toBe(1);
  expect(await rooms.list("alice")).toHaveLength(1);
  await handle.close();
});
