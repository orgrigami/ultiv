// The connectors slice of the smoke run: add a fake Streamable HTTP server
// through REST on the running stack (no restart), see it connect and list its
// tools, check owner scoping and plain-words errors, then remove it.
import { startHttpFake } from "@spreissen/ext/mcp-testing";

type Call = (
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<{ status: number; json: any }>;

const until = async (check: () => Promise<boolean>, ms = 8_000): Promise<boolean> => {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

export const smokeMcp = async (
  call: Call,
  headers: Record<string, string>,
  expect: (name: string, ok: boolean) => void,
): Promise<void> => {
  const fake = await startHttpFake();
  try {
    const input = {
      name: "Smoke fake",
      transport: "auto",
      url: `${fake.base}/mcp`,
      command: null,
      auth: { kind: "none" },
      profiles: null,
      enabled: true,
      autoAllowReadOnly: false,
      disabledTools: [],
    };
    const added = await call("POST", "/api/mcp/servers", input, headers);
    expect("mcp add", added.status === 200 && typeof added.json.id === "string");
    const id = String(added.json.id);
    const path = `/api/mcp/servers/${encodeURIComponent(id)}`;
    const connected = await until(async () => {
      const list = await call("GET", "/api/mcp/servers", undefined, headers);
      const server = list.json.servers.find((entry: { id: string }) => entry.id === id);
      return server?.state === "connected" && server.tools.length > 0;
    });
    expect("mcp connects live and lists tools", connected);
    const stranger = await call("GET", "/api/mcp/servers", undefined, { "x-ultiv-user": "other" });
    expect("mcp list owner-scoped", stranger.json.servers.length === 0);
    const foreign = await call("DELETE", path, undefined, { "x-ultiv-user": "other" });
    expect("mcp remove owner-scoped", foreign.status === 404);
    const bad = await call("POST", "/api/mcp/servers", { ...input, url: "ftp://x" }, headers);
    expect("mcp bad input refused", bad.status === 400 && typeof bad.json.error === "string");
    const off = await call("PATCH", path, { ...input, enabled: false }, headers);
    expect("mcp switch off", off.status === 200 && off.json.state === "disabled");
    const removed = await call("DELETE", path, undefined, headers);
    expect("mcp remove", removed.status === 200);
    const after = await call("GET", "/api/mcp/servers", undefined, headers);
    expect("mcp removed live", after.json.servers.length === 0);
    // Secure input: nothing waits, so values are refused without an echo.
    const stray = await call(
      "POST",
      "/api/secrets/nope",
      { values: { secret: "abcdefgh" } },
      headers,
    );
    expect(
      "secure input refuses a request nobody made",
      stray.status === 404 && !JSON.stringify(stray.json).includes("abcdefgh"),
    );
  } finally {
    await fake.close();
  }
};
