/**
 * Slice 10: the host-access switch at DECIDE time. A queued host-direct
 * call (bash_host here; the stdio connector shape is `isHostDirectCall`'s
 * second arm) is refused when approved after the switch turned off — the
 * "always allow" save is skipped while off, and the audit row reads refused.
 * Over a real in-memory mind, with the conversation mapped to its bot.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind, type MindService } from "@spriessen/mind";
import { approveMethod } from "./session-methods.ts";
import { hostSwitchRefusal, isHostDirectCall } from "./host-switch.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-host-decide-"));
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");
process.env["BOT_FILES_DIR"] = join(scratch, "bot-files");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CID = "conv-1";
const cell = () => ({ change: () => {} });
const scope = (mind: MindService) =>
  ({
    host: {},
    mind,
    owner: "owner-a",
    sessionId: "s1",
    conversation: Promise.resolve({} as never),
    conversationId: Promise.resolve(CID),
    cells: { pending: cell() },
    inFlight: { start: () => {}, finish: () => true },
  }) as never;

/** Map the test conversation to `bot` for the index reads (profileOf). */
const withBot = (mind: MindService, bot: unknown): MindService =>
  ({
    ...mind,
    profiles: { ...mind.profiles, profileOf: (id: string) => (id === CID ? bot : undefined) },
  }) as MindService;

const setup = async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  await handle.mind.org.ensureOrg("owner-a", "Org A", true);
  return handle;
};

describe("the switch at decide time", () => {
  it("names bash_host as host-direct and ordinary tools not", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    expect(isHostDirectCall(handle.mind, "bash_host")).toBe(true);
    expect(isHostDirectCall(handle.mind, "web_search")).toBe(false);
    await handle.close();
  });

  it("refuses approving a queued bash_host while the switch is off", async () => {
    const handle = await setup();
    const { mind } = handle;
    const bot = await mind.profiles.create("owner-a", { name: "Kestrel", onboard: false });
    const stubbed = withBot(mind, bot);
    const parked = Effect.runPromise(
      mind.approvals.request(CID, "k1", {
        callId: "k1",
        name: "bash_host",
        input: { script: "ls" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await hostSwitchRefusal(stubbed, CID, "bash_host")).toContain("host access is off");
    const approve = approveMethod(scope(stubbed));
    const out = await approve({ callId: "k1", approved: true, always: true }, {} as never);
    expect(out.ok).toBe(true);
    expect(out.stored).toBeNull(); // the rule save is skipped while off
    expect(await parked).toBe(false); // the gate opens DENIED
    const rows = mind.audit.tail(50).filter((event) => event.kind === "approval");
    expect(rows.at(-1)?.ok).toBe(false);
    expect(String(rows.at(-1)?.error)).toContain("host access is off");
    await handle.close();
  });

  it("lets the same approval stand once the switch is on", async () => {
    const handle = await setup();
    const { mind } = handle;
    const bot = await mind.profiles.create("owner-a", { name: "Wren", onboard: false });
    const on = { ...bot, hostAccess: true };
    const stubbed = withBot(mind, on);
    const parked = Effect.runPromise(
      mind.approvals.request(CID, "k2", {
        callId: "k2",
        name: "bash_host",
        input: { script: "ls" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await hostSwitchRefusal(stubbed, CID, "bash_host")).toBeNull();
    const approve = approveMethod(scope(stubbed));
    await approve({ callId: "k2", approved: true }, {} as never);
    expect(await parked).toBe(true);
    await handle.close();
  });
});
