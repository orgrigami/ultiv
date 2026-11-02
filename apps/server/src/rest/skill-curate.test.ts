/**
 * The consolidation REST surface over a real offline mind (fake RouteArgs,
 * no HTTP): POST /api/skills/:profile/curate parks absorb proposals for
 * overlapping learned skills, another owner's profile is the unknown-bot
 * 404, accepting one merges the sources into the kept skill ATOMICALLY
 * (sources gone from the list, their history still answering), and a stale
 * proposal refuses without side effects.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { skillRoutes } from "./skills.ts";
import type { RouteArgs } from "./types.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-skill-curate-rest-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["SKILLS_DIR"] = join(scratch, "skills");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let mind: Awaited<ReturnType<typeof openMind>>["mind"];
let bot = "";

/** Minimal RouteArgs over the real mind; captures the JSON response. */
const routeArgs = (opts: {
  path: string;
  method?: string;
  owner?: string;
}): { args: RouteArgs; status: () => number; body: () => any } => {
  let captured: { status: number; body: unknown } | undefined;
  return {
    args: {
      mind,
      scheduler: {} as RouteArgs["scheduler"],
      req: { method: opts.method ?? "POST" } as RouteArgs["req"],
      res: {} as RouteArgs["res"],
      url: new URL(`http://localhost${opts.path}`),
      owner: opts.owner ?? "harry",
      path: opts.path,
      json: (status, body) => {
        captured = { status, body };
      },
      readJson: async <T>() => ({}) as T,
      readBody: async () => Buffer.from("{}"),
    },
    status: () => captured?.status ?? 0,
    body: () => captured?.body,
  };
};

const doc = (name: string, description: string, text: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${text}`;

const SHARED = `filing supplier invoices into the weekly ledger with totals
every invoice lands in the supplier folder before the weekly ledger close
note the amount due and the due date beside the totals in the ledger`;

const PAIR = {
  keep: {
    name: "invoice-filing",
    body: doc(
      "invoice-filing",
      "Filing supplier invoices weekly",
      `${SHARED}\nthen archive the batch`,
    ),
  },
  source: {
    name: "weekly-invoice-close",
    body: doc(
      "weekly-invoice-close",
      "The weekly invoice close",
      `${SHARED}\nand confirm the close`,
    ),
  },
};

beforeAll(async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  mind = handle.mind;
  bot = (await mind.profiles.create("harry", { name: "Filer", onboard: false })).id;
});

afterAll(async () => {
  await (mind as { close?: () => Promise<void> }).close?.();
  rmSync(scratch, { recursive: true, force: true });
});

const seedPair = async (): Promise<void> => {
  // Close any open plans from earlier tests so this pair parks fresh ones.
  for (const proposal of await mind.skills.proposalsOf("harry", bot)) {
    if (proposal.status === "open") await mind.skills.decide("harry", bot, proposal.id, "rejected");
  }
  await mind.skills.write("harry", bot, {
    name: PAIR.keep.name,
    body: PAIR.keep.body,
    origin: "self",
  });
  await mind.skills.write("harry", bot, {
    name: PAIR.source.name,
    body: PAIR.source.body,
    origin: "self",
  });
};

describe("POST /api/skills/:profile/curate", () => {
  it("parks one absorb proposal for an overlapping pair", async () => {
    await seedPair();
    const run = routeArgs({ path: `/api/skills/${bot}/curate` });
    expect(await skillRoutes(run.args)).toBe(true);
    expect(run.status()).toBe(200);
    const proposals = run.body().proposals as {
      id: string;
      kind: string;
      skill: string;
      absorbed: { name: string; version: number }[];
    }[];
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.kind).toBe("absorb");
    expect(proposals[0]?.skill).toBe(PAIR.keep.name);
    expect(proposals[0]?.absorbed.map((source) => source.name)).toEqual([PAIR.source.name]);
  });

  it("another owner's profile is the unknown-bot 404", async () => {
    const run = routeArgs({ path: `/api/skills/${bot}/curate`, owner: "other" });
    expect(await skillRoutes(run.args)).toBe(true);
    expect(run.status()).toBe(404);
    expect((run.body() as { error: string }).error).toContain("no profile");
  });

  it("accepting merges atomically: sources leave the list, history stays, target records them", async () => {
    const proposals = await mind.skills.proposalsOf("harry", bot);
    const absorb = proposals.find(
      (proposal) => proposal.kind === "absorb" && proposal.status === "open",
    );
    expect(absorb).toBeDefined();
    const accept = routeArgs({ path: `/api/skills/${bot}/proposals/${absorb?.id}/accept` });
    expect(await skillRoutes(accept.args)).toBe(true);
    expect(accept.status()).toBe(200);
    expect((accept.body() as { status: string }).status).toBe("accepted");

    const listed = await mind.skills.list("harry", bot);
    const names = listed.map((meta) => meta.name);
    expect(names).toContain(PAIR.keep.name);
    expect(names).not.toContain(PAIR.source.name);
    const target = await mind.skills.read("harry", bot, PAIR.keep.name);
    expect(target?.body).toContain(`## Absorbed from ${PAIR.source.name}`);
    expect(target?.meta.absorbed).toEqual([PAIR.source.name]);
    const sourceHistory = await mind.skills.versions("harry", bot, PAIR.source.name);
    expect(sourceHistory.length).toBeGreaterThan(0);
    const targetVersions = await mind.skills.versions("harry", bot, PAIR.keep.name);
    expect(targetVersions.at(-1)?.reason).toContain(`absorbed ${PAIR.source.name}`);
  });

  it("a stale proposal (source removed after drafting) refuses without side effects", async () => {
    await seedPair();
    const parked = await mind.skills.curate("harry", bot);
    expect(parked).toHaveLength(1);
    await mind.skills.remove("harry", bot, PAIR.source.name);
    const before = await mind.skills.read("harry", bot, PAIR.keep.name);
    const accept = routeArgs({ path: `/api/skills/${bot}/proposals/${parked[0]?.id}/accept` });
    expect(await skillRoutes(accept.args)).toBe(true);
    expect(accept.status()).toBe(400);
    expect((accept.body() as { error: string }).error).toContain(
      `removed since this plan was drafted`,
    );
    const after = await mind.skills.read("harry", bot, PAIR.keep.name);
    expect(after?.body).toBe(before?.body);
    expect(after?.meta.absorbed).toEqual(before?.meta.absorbed);
    const still = await mind.skills.proposalsOf("harry", bot);
    expect(still.find((proposal) => proposal.id === parked[0]?.id)?.status).toBe("open");
  });

  it("a target rewritten after drafting refuses too", async () => {
    await seedPair();
    const parked = await mind.skills.curate("harry", bot);
    expect(parked).toHaveLength(1);
    await mind.skills.write("harry", bot, {
      name: PAIR.keep.name,
      body: PAIR.keep.body.replace("archive", "file and archive"),
      origin: "self",
    });
    const accept = routeArgs({ path: `/api/skills/${bot}/proposals/${parked[0]?.id}/accept` });
    expect(await skillRoutes(accept.args)).toBe(true);
    expect(accept.status()).toBe(400);
    expect((accept.body() as { error: string }).error).toContain(
      "changed since this plan was drafted",
    );
    expect((await mind.skills.list("harry", bot)).map((meta) => meta.name)).toContain(
      PAIR.source.name,
    );
  });
});
