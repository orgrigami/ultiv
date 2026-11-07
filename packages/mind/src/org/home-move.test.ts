/**
 * A bot moved between homes (slice 2 done-mean, exercised with slice 2c's
 * org-shared resolver): the OLD home's VM loses the bot's Linux user — the
 * entity wires the purge's retirement sweep to every move — and the new home
 * resolves the SAME stored uid for the bot's first `bash` there. The sweep is
 * the real wired one: the VM cannot be reached in a test, so the removal is
 * MARKED for the old VM's next boot (ext's pending-removal file), which is
 * exactly what this test asserts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { readPendingRemovals, sandboxNameOf } from "@spriessen/ext";
import {
  botUidOf,
  botUidPeek,
  botUserName,
  homeScopeDir,
  homeScopeOfProfile,
  openMind,
} from "@spriessen/mind";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-home-move-"));
// The sweep's pending file lands beside the artifact store: point it at the
// scratch dir (the env is read at call time, so module load is early enough).
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
const root = join(scratch, "artifacts");
afterAll(() => handle?.close().then(() => rmSync(scratch, { recursive: true, force: true })));

type MindHandle = Awaited<ReturnType<typeof openMind>>;

let handle: MindHandle;
let mind: MindHandle["mind"];
const owner = "owner-a";
let teamA = "";
let teamB = "";
let mover = "";

/** Polls until the async sweep's mark lands (or fails the test loudly). */
const until = async (probe: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > end) throw new Error("timed out waiting for the retirement sweep");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  mind = handle.mind;
  await mind.org.ensureOrg(owner, "Personal", true);
  teamA = (await mind.org.createTeam({ name: "Ops" }, owner)).id;
  teamB = (await mind.org.createTeam({ name: "Lab" }, owner)).id;
  // A team bot whose first `bash` already ran (it has a uid). An org
  // bot exists first: the first bot of a workspace lives in the org.
  await mind.profiles.create(owner, { name: "Keeper", onboard: false });
  mover = (
    await mind.profiles.create(owner, {
      name: "Mover",
      teamId: teamA,
      onboard: false,
    })
  ).id;
  await botUidOf(mind.converse)(mover);
});

describe("a bot moved between homes", () => {
  it("keeps its stored uid in the new home VM and is retired from the old one", async () => {
    const oldHome = { kind: "team", teamId: teamA } as const;
    const newHome = { kind: "team", teamId: teamB } as const;
    const uid = await botUidPeek(mind.converse)(mover);
    expect(uid).toBeGreaterThanOrEqual(10_000);
    await mind.profiles.update(owner, mover, { teamId: teamB });
    const profile = (await mind.profiles.list(owner)).find((row) => row.id === mover);
    expect(profile?.teamId).toBe(teamB);
    // The new home resolves the SAME stored uid on the bot's first bash there.
    const scope = await homeScopeOfProfile(mind.converse, root)(owner, {
      id: mover,
      teamId: teamB,
    });
    expect(scope?.dir).toBe(homeScopeDir(root, owner, newHome));
    expect(scope?.user?.uid).toBe(uid);
    expect(scope?.user?.name).toBe(botUserName(mover));
    // Nothing is marked against the NEW home's VM; the OLD one gets the mark.
    expect(readPendingRemovals(sandboxNameOf(homeScopeDir(root, owner, newHome)))).toEqual([]);
    await until(
      () => readPendingRemovals(sandboxNameOf(homeScopeDir(root, owner, oldHome))).length > 0,
    );
    expect(readPendingRemovals(sandboxNameOf(homeScopeDir(root, owner, oldHome)))).toEqual([
      { name: botUserName(mover), home: `/home/${mover}` },
    ]);
  });
});
