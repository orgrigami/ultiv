import { afterEach, describe, expect, it } from "vite-plus/test";
import { startHttpFake, type HttpFake } from "./testing/http-fake.ts";
import { addLateTool } from "./testing/fake-server.ts";
import { makeRig, remoteInput, stdioInput, textOf, waitFor, type Rig } from "./testing/rig.ts";

const OWNER = "harry";
const CALL = { timeoutMs: 5_000 };
let rig: Rig | undefined;
let fake: HttpFake | undefined;

afterEach(async () => {
  await rig?.close();
  await fake?.close();
  rig = undefined;
  fake = undefined;
});

describe("MCP transports", () => {
  it("speaks Streamable HTTP: lists, calls, errors, list_changed", async () => {
    fake = await startHttpFake();
    rig = makeRig();
    const added = rig.manager.add(OWNER, remoteInput(`${fake.base}/mcp`));
    const info = await waitFor(rig.manager, OWNER, added.id, "connected");
    expect(info.activeTransport).toBe("http");
    expect(info.serverName).toBe("fake-mcp");
    expect(info.tools.map((tool) => tool.name)).toContain("fake_echo");
    const echo = info.tools.find((tool) => tool.remoteName === "echo");
    expect(echo).toMatchObject({ readOnly: true, destructive: false });
    expect(info.tools.find((tool) => tool.remoteName === "delete_everything")?.destructive).toBe(
      true,
    );
    const result = await rig.manager.call(OWNER, added.id, "echo", { text: "hi" }, CALL);
    expect(textOf(result)).toBe("echo: hi");
    const broken = await rig.manager.call(OWNER, added.id, "broken", {}, CALL);
    expect(broken.isError).toBe(true);
    // The server adds a tool: tools/list_changed refreshes the list live.
    for (const server of fake.servers) addLateTool(server, "late_tool");
    await expect
      .poll(() => rig?.manager.info(OWNER, added.id)?.tools.map((tool) => tool.remoteName))
      .toContain("late_tool");
  });

  it("falls back to legacy SSE when Streamable HTTP is refused, and can force SSE", async () => {
    fake = await startHttpFake({ sseOnly: true });
    rig = makeRig();
    const auto = rig.manager.add(OWNER, remoteInput(`${fake.base}/sse`, { name: "Old" }));
    const info = await waitFor(rig.manager, OWNER, auto.id, "connected");
    expect(info.activeTransport).toBe("sse");
    expect(textOf(await rig.manager.call(OWNER, auto.id, "echo", { text: "sse" }, CALL))).toBe(
      "echo: sse",
    );
    const forced = rig.manager.add(OWNER, remoteInput(`${fake.base}/sse`, { transport: "sse" }));
    expect((await waitFor(rig.manager, OWNER, forced.id, "connected")).activeTransport).toBe("sse");
    const page = await rig.manager.listResources(OWNER, forced.id, undefined, CALL);
    expect(page.resources[0]?.uri).toBe("file:///readme.md");
  });

  it("forced http does not fall back", async () => {
    fake = await startHttpFake({ sseOnly: true });
    rig = makeRig();
    const added = rig.manager.add(OWNER, remoteInput(`${fake.base}/sse`, { transport: "http" }));
    const info = await waitFor(rig.manager, OWNER, added.id, "failed");
    expect(info.reason).toMatch(/405|refused|failed|http/i);
  });

  it("runs stdio with a scrubbed env, redacts its vault secret, and restarts after a crash", async () => {
    process.env.SPREISSEN_HOST_SECRET = "host-only-value";
    rig = makeRig();
    const item = rig.vault.create(OWNER, {
      kind: "key",
      name: "Token",
      key: { secret: "tok_live_abcdef123456" },
    });
    const added = rig.manager.add(
      OWNER,
      stdioInput({
        name: "Local",
        command: {
          command: process.execPath,
          args: [new URL("./testing/stdio-server.ts", import.meta.url).pathname],
          env: [{ name: "FAKE_TOKEN", item: item.id }],
        },
      }),
    );
    await waitFor(rig.manager, OWNER, added.id, "connected");
    const leak = textOf(await rig.manager.call(OWNER, added.id, "env_leak", {}, CALL));
    expect(leak).toContain("leak=none");
    expect(leak).toContain(`${added.id}`);
    const who = textOf(await rig.manager.call(OWNER, added.id, "whoami", {}, CALL));
    // The raw result still has it; everything the model sees is scrubbed.
    expect(rig.manager.scrub(OWNER, added.id, who)).not.toContain("tok_live_abcdef123456");
    await rig.manager.call(OWNER, added.id, "crash", {}, CALL);
    await waitFor(rig.manager, OWNER, added.id, "connected");
    expect(textOf(await rig.manager.call(OWNER, added.id, "echo", { text: "back" }, CALL))).toBe(
      "echo: back",
    );
    delete process.env.SPREISSEN_HOST_SECRET;
  });

  it("explains a missing command in plain words", async () => {
    rig = makeRig();
    const added = rig.manager.add(
      OWNER,
      stdioInput({ command: { command: "no-such-binary-xyz", args: [], env: [] } }),
    );
    const info = await waitFor(rig.manager, OWNER, added.id, "failed");
    expect(info.reason).toMatch(/not found|ENOENT|no such/i);
  });
});
