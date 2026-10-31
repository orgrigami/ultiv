import { describe, expect, it } from "vite-plus/test";
import { proxyTo } from "../../dev-proxy.ts";

describe("dev proxy", () => {
  const proxy = proxyTo("http://127.0.0.1:47000/");

  it("forwards the client address on every route, so the LAN never looks like loopback", () => {
    for (const [path, options] of Object.entries(proxy)) {
      expect(options.xfwd, path).toBe(true);
    }
  });

  it("carries the live /push socket as well as the chord socket", () => {
    expect(proxy["^/push$"]).toMatchObject({ target: "ws://127.0.0.1:47000", ws: true });
    expect(proxy["/chord"]).toMatchObject({ target: "ws://127.0.0.1:47000", ws: true });
    expect(proxy["/api"]?.target).toBe("http://127.0.0.1:47000");
  });
});
