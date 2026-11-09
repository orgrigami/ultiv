/**
 * The dev/preview proxy: /api, /hooks, the chord socket, the live `/push`
 * socket and the browser cast's `/cast` socket ride the page's origin to the
 * server behind it.
 *
 * `xfwd` matters for sign-in: without it every proxied request reaches the
 * server from 127.0.0.1 with no forwarding header, so a phone on the LAN or
 * the tailnet would look like the host itself (and could set the first
 * passcode). With it the server sees the real client in `x-forwarded-for`.
 */
import type { ProxyOptions } from "vite-plus";

export function proxyTo(api: string): Record<string, ProxyOptions> {
  const target = api.replace(/\/$/, "");
  const socketTarget = target.replace(/^http/, "ws");
  return {
    "/api": { target, xfwd: true },
    "/hooks": { target, xfwd: true },
    "/chord": { target: socketTarget, ws: true, xfwd: true },
    // Exact path: a static file such as /push-icon.png must not match.
    "^/push$": { target: socketTarget, ws: true, xfwd: true },
    // The live browser cast's socket (its query names the view).
    "^/cast(\\?|$)": { target: socketTarget, ws: true, xfwd: true },
  };
}
