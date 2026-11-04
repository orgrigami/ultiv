import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { proxyTo } from "./dev-proxy.ts";

// Reachable on every facet by default: localhost / 127.0.0.1 / [::1], the LAN,
// the tailnet (IP, MagicDNS short name, *.ts.net, `tailscale serve` HTTPS) or
// any other name that routes here. HOST narrows the bind; ALLOWED_HOSTS
// (comma-separated, leading dot = suffix) narrows the accepted Host names.
const host = process.env.HOST ?? true;
const allowedHosts = parseAllowedHosts(process.env.ALLOWED_HOSTS);
// /api, /hooks, /chord and /push ride the same origin as the page, so
// whichever facet reached the web app also reaches the server behind it.
// The proxy forwards the client address (see dev-proxy.ts).
const proxy = proxyTo(process.env.API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`);

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), tailwindcss(), react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: { host, allowedHosts, proxy },
  preview: { host, allowedHosts, proxy },
});

function parseAllowedHosts(raw: string | undefined): true | string[] {
  const names = (raw ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  return names.length === 0 || names.includes("*") ? true : names;
}
