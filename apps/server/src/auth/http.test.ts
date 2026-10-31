/**
 * The loopback test decides who may set the first passcode, so it must see
 * the client behind a proxy, not the proxy itself.
 */
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { isLoopback } from "./http.ts";

const request = (peer: string, headers: Record<string, string> = {}): IncomingMessage =>
  ({ socket: { remoteAddress: peer }, headers }) as unknown as IncomingMessage;

describe("isLoopback", () => {
  it("accepts a direct loopback client", () => {
    expect(isLoopback(request("127.0.0.1"))).toBe(true);
    expect(isLoopback(request("::1"))).toBe(true);
  });

  it("refuses a direct LAN client, whatever headers it sends", () => {
    expect(isLoopback(request("10.20.30.40"))).toBe(false);
    expect(isLoopback(request("10.20.30.40", { "x-forwarded-for": "127.0.0.1" }))).toBe(false);
  });

  it("refuses a LAN client the dev proxy forwarded (it arrives from 127.0.0.1)", () => {
    expect(isLoopback(request("127.0.0.1", { "x-forwarded-for": "10.20.30.40" }))).toBe(false);
    // A spoofed first hop does not help: the proxy appends the real one.
    expect(
      isLoopback(request("127.0.0.1", { "x-forwarded-for": "127.0.0.1, 10.20.30.40" })),
    ).toBe(false);
  });

  it("accepts the host's own browser through the dev proxy", () => {
    expect(
      isLoopback(
        request("127.0.0.1", { "x-forwarded-for": "::1", "x-forwarded-proto": "http" }),
      ),
    ).toBe(true);
  });

  it("refuses proxies that hide the client", () => {
    expect(isLoopback(request("127.0.0.1", { "x-forwarded-proto": "https" }))).toBe(false);
    expect(isLoopback(request("127.0.0.1", { forwarded: "for=127.0.0.1" }))).toBe(false);
    expect(isLoopback(request("127.0.0.1", { "x-real-ip": "10.20.30.40" }))).toBe(false);
  });
});
