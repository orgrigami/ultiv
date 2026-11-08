/**
 * The typed tables: create/rows/add/update/remove over the real doc, with
 * type checks, per-profile scoping and the row cap pruning oldest-first.
 */
import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "../entity.ts";
import { TABLE_LIMIT, TABLE_ROW_CAP } from "./tables.ts";

describe("typed tables", () => {
  it("creates, adds typed rows, updates, lists newest first, removes", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const bot = await handle.mind.profiles.create("owner", { name: "Keeper" });
    await handle.mind.tables.create({
      owner: "owner",
      profile: bot.id,
      name: "invoice-tracker",
      columns: [
        { name: "invoice", type: "string" },
        { name: "amount", type: "number" },
        { name: "paid", type: "boolean" },
      ],
    });
    const row = await handle.mind.tables.addRow("owner", bot.id, "invoice-tracker", {
      invoice: "INV-1",
      amount: 250_000,
      paid: false,
    });
    await handle.mind.tables.addRow("owner", bot.id, "invoice-tracker", {
      invoice: "INV-2",
      amount: 1_000,
      paid: null,
    });
    let rows = await handle.mind.tables.rows("owner", bot.id, "invoice-tracker");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.data.invoice).toBe("INV-2"); // newest first
    await handle.mind.tables.setRow("owner", bot.id, "invoice-tracker", row.id, {
      invoice: "INV-1",
      amount: 250_000,
      paid: true,
    });
    rows = await handle.mind.tables.rows("owner", bot.id, "invoice-tracker");
    expect(rows.find((entry) => entry.id === row.id)?.data.paid).toBe(true);
    expect(await handle.mind.tables.removeRow("owner", bot.id, "invoice-tracker", row.id)).toBe(
      true,
    );
    expect(await handle.mind.tables.rows("owner", bot.id, "invoice-tracker")).toHaveLength(1);
    expect(await handle.mind.tables.remove("owner", bot.id, "invoice-tracker")).toBe(true);
    expect(await handle.mind.tables.list("owner", bot.id)).toHaveLength(0);
    await handle.close();
  });

  it("refuses wrong types and unknown columns with a sentence", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const bot = await handle.mind.profiles.create("owner", { name: "Keeper" });
    await handle.mind.tables.create({
      owner: "owner",
      profile: bot.id,
      name: "ledger",
      columns: [
        { name: "amount", type: "number" },
        { name: "note", type: "string" },
      ],
    });
    await expect(
      handle.mind.tables.addRow("owner", bot.id, "ledger", { amount: "lots" }),
    ).rejects.toMatchObject({ reason: expect.stringContaining("amount must be number") });
    await expect(
      handle.mind.tables.addRow("owner", bot.id, "ledger", { amount: 1, extra: "x" }),
    ).rejects.toMatchObject({ reason: expect.stringContaining("unknown columns: extra") });
    await handle.close();
  });

  it("scopes per profile: a sibling never sees or spends another's tables", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const a = await handle.mind.profiles.create("owner", { name: "A" });
    const b = await handle.mind.profiles.create("owner", { name: "B" });
    await handle.mind.tables.create({
      owner: "owner",
      profile: a.id,
      name: "mine",
      columns: [{ name: "n", type: "number" }],
    });
    expect(await handle.mind.tables.list("owner", b.id)).toHaveLength(0);
    await expect(handle.mind.tables.rows("owner", b.id, "mine")).rejects.toMatchObject({});
    // B can create its own table with the same name.
    await handle.mind.tables.create({
      owner: "owner",
      profile: b.id,
      name: "mine",
      columns: [{ name: "n", type: "number" }],
    });
    expect(await handle.mind.tables.list("owner", b.id)).toHaveLength(1);
    await handle.close();
  });

  it("caps tables per profile and prunes rows oldest-first", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const bot = await handle.mind.profiles.create("owner", { name: "Keeper" });
    for (let n = 0; n < TABLE_LIMIT; n += 1) {
      await handle.mind.tables.create({
        owner: "owner",
        profile: bot.id,
        name: `t${n}`,
        columns: [{ name: "n", type: "number" }],
      });
    }
    await expect(
      handle.mind.tables.create({
        owner: "owner",
        profile: bot.id,
        name: "over",
        columns: [{ name: "n", type: "number" }],
      }),
    ).rejects.toMatchObject({ reason: expect.stringContaining("tables") });
    for (let n = 0; n <= TABLE_ROW_CAP; n += 1) {
      await handle.mind.tables.addRow("owner", bot.id, "t0", { n });
    }
    const rows = await handle.mind.tables.rows("owner", bot.id, "t0", TABLE_ROW_CAP + 1);
    expect(rows).toHaveLength(TABLE_ROW_CAP);
    // Newest first: the cap dropped row 0 (the OLDEST); 1000 leads.
    expect(rows[0]?.data.n).toBe(TABLE_ROW_CAP);
    expect(rows[rows.length - 1]?.data.n).toBe(1);
    await handle.close();
  });
});
