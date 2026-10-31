import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { remoteInput, startHttpFake, waitFor } from "@spreissen/ext/mcp-testing";
import { openMind } from "../entity.ts";

describe("Connectors on a running mind", () => {
  it("adds and removes a server's tools without a restart", async () => {
    const fake = await startHttpFake();
    const dir = mkdtempSync(join(tmpdir(), "spreissen-mcp-live-"));
    const handle = await openMind({ storage: new MemoryStorage(), mcp: { dir } });
    const { mind } = handle;
    const before = mind.describe().tools;
    expect(before).toContain("connector_load");
    expect(before).not.toContain("fake_echo");
    const added = mind.mcp.add("harry", remoteInput(`${fake.base}/mcp`));
    await waitFor(mind.mcp, "harry", added.id, "connected");
    expect(mind.describe().tools).toContain("fake_echo");
    // A tool appearing on the server shows up live too.
    expect(mind.describe().tools).not.toContain("fake_late");
    const { addLateTool } = await import("@spreissen/ext/mcp-testing");
    for (const server of fake.servers) addLateTool(server, "late");
    await expect.poll(() => mind.describe().tools).toContain("fake_late");
    expect(await mind.mcp.remove("harry", added.id)).toBe(true);
    expect(mind.describe().tools).not.toContain("fake_echo");
    expect(mind.describe().tools).toContain("connector_load");
    await handle.close();
    await fake.close();
  });
});
