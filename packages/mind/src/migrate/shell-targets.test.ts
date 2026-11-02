/**
 * The stored-entry migration for the bash merge: `bash_host:=<script>`
 * becomes `bash@host:=<script>`, and the ROUND-TRIP rule holds — run the
 * migrated rules back through the gate and the next identical call's outcome
 * is what it was before the merge (a saved rule never re-hits a refusal the
 * owner already approved away). Bare `bash` entries are NOT touched, inert
 * `bash_host:glob` entries are left alone, and no entry content is logged.
 */
import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { mayAutoApprove, parseTargetExactEntry } from "../auto-approve.ts";
import { openMind } from "../entity.ts";
import { commitProfiles, readProfiles } from "../profiles/docs.ts";
import { Effect } from "effect";
import { migrateShellEntry, migrateShellTargets, shellTargetsPending } from "./shell-targets.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

describe("migrateShellEntry", () => {
  it("rewrites the legacy exact form to the host target form", () => {
    expect(migrateShellEntry("bash_host:=git status")).toBe("bash@host:=git status");
    expect(migrateShellEntry("bash_host:=ls -la && echo done")).toBe(
      "bash@host:=ls -la && echo done",
    );
    // Bare bash entries are NOT touched: the matcher preserves their meaning.
    expect(migrateShellEntry("bash")).toBe("bash");
    expect(migrateShellEntry("bash:git *")).toBe("bash:git *");
    // Inert legacy globs stay as stored.
    expect(migrateShellEntry("bash_host:git *")).toBe("bash_host:git *");
    expect(migrateShellEntry("http_request:POST")).toBe("http_request:POST");
  });
});

describe("migrateShellTargets (round trip)", () => {
  it("moves every stored bash_host:= entry and the gate keeps its verdict", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { converse } = handle.mind;
    const script = "git status && git log -1";
    const legacy = `bash_host:=${script}`;
    await run(
      commitProfiles(converse, (rows) => [
        ...rows,
        {
          id: "p-legacy",
          owner: "owner-a",
          kind: "session" as const,
          name: "Legacy",
          description: "",
          persona: "",
          timezone: "UTC",
          model: null,
          toolAllowlist: null,
          policies: {
            autoApprove: [legacy, "bash", "bash_host:git *", "web_search:weather *"],
            approvalMode: "manual" as const,
            approvalTimeout: "deny" as const,
          },
          hostAccess: true,
          departmentId: null,
          createdAt: 0,
          archivedAt: null,
        } as never,
      ]),
    );
    expect(await shellTargetsPending(converse)).toBe(1);
    expect(await migrateShellTargets(converse)).toBe(1);
    // Repeatable: a second run moves nothing.
    expect(await migrateShellTargets(converse)).toBe(0);
    expect(await shellTargetsPending(converse)).toBe(0);

    const rows = await run(readProfiles(converse));
    const migrated = rows.find((row) => row.id === "p-legacy");
    expect(migrated?.policies.autoApprove).toEqual([
      `bash@host:=${script}`,
      "bash",
      "bash_host:git *",
      "web_search:weather *",
    ]);
    // The migrated rule parses as a target exact entry carrying the script.
    expect(parseTargetExactEntry(`bash@host:=${script}`)).toEqual({
      target: { kind: "host" },
      script,
    });

    // ROUND TRIP: the identical call the owner approved away still runs.
    const entries = migrated?.policies.autoApprove ?? [];
    const hostCall = { callId: "r1", name: "bash", input: { script, target: "host" } };
    expect(mayAutoApprove(entries, hostCall)).toBe(true);
    // A different script still asks; the stored bare `bash` grant keeps
    // approving exactly its vm calls — never a host or node call.
    expect(
      mayAutoApprove(entries, {
        callId: "r2",
        name: "bash",
        input: { script: `${script}; rm -rf /tmp/x`, target: "host" },
      }),
    ).toBe(false);
    expect(
      mayAutoApprove(entries, { callId: "r3", name: "bash", input: { script, target: "node" } }),
    ).toBe(false);
    // The stored bare `bash` grant keeps approving exactly its vm calls.
    expect(mayAutoApprove(entries, { callId: "r4", name: "bash", input: { script: "ls" } })).toBe(
      true,
    );
    expect(
      mayAutoApprove(entries, {
        callId: "r5",
        name: "bash",
        input: { script: "ls", target: "host" },
      }),
    ).toBe(false);
    await handle.close();
  });
});
