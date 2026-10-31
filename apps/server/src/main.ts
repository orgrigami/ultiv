/**
 * Wires the mind (the platform's AI entity), the chord host, and the
 * WebSocket + HTTP + REST listeners. The app is thin: transport and registry
 * REST live here; every AI capability lives in @spriessen/mind.
 */
import { createServer } from "node:http";
import { reachableUrls } from "./listen.ts";
import { pathToFileURL } from "node:url";
import { acceptWebSockets, createHost } from "@earendil-works/chord";
import type { Storage } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { WebSocketServer } from "ws";
import { Ping } from "@spriessen/contracts";
import { artifactsDir, copyArtifact, resolveInside } from "@spriessen/ext";
import { httpPlugin } from "@spriessen/ext";
import { closeWebhookPump } from "./webhooks.ts";
import { startSensorLoop, type SensorLoop } from "./sensors.ts";
import { startMemoryTidy } from "./memory-tidy.ts";
import { wireEscalationPager } from "./attention.ts";
import { startPush } from "./push/index.ts";
import { openMind, sealWebhookTokens, migrateOwners } from "@spriessen/mind";
import { migrateStorage } from "./auth/migrate-storage.ts";
import { OWNER_ID } from "./identity.ts";
import { can } from "./rest/can.ts";
import { startScheduler, type CronScheduler } from "./cron.ts";
import { principalOfAccount, type Principal } from "./identity.ts";
import { authorize } from "./auth/guard.ts";
import { LIVE_PATH, liveConnections, liveHub } from "./live.ts";
import { watchRunningTasks } from "./live-tasks.ts";
import { AuthStore } from "./auth/store.ts";
import { createRestHandler } from "./rest.ts";
import { serveSession } from "./session.ts";

export type { Principal } from "./identity.ts";

/**
 * Boots the whole stack: mind, chord host, cron scheduler, REST + WebSocket
 * listeners. `close()` stops the scheduler, drops links, then closes the
 * mind's scope (harness finalizers).
 */
export async function buildStack(options?: {
  readonly storage?: Storage;
  readonly vault?: { readonly dir?: string };
}) {
  const handle = await openMind({
    plugins: [httpPlugin],
    // The host capability: today every bot runs under the owner's authority,
    // so can()'s account check is the whole rule (see rest/can.ts).
    authz: {
      hostAccess: (scope) => can(scope.owner, "change", { type: "host" }),
    },
    // Schedules created by tools re-arm the in-process scheduler; the closure
    // is late-bound — `startScheduler` runs right after the mind opens.
    schedules: { onChanged: () => refreshSchedules() },
    ...(options?.storage !== undefined ? { storage: options.storage } : {}),
    ...(options?.vault !== undefined ? { vault: options.vault } : {}),
    // Envelope artifact grants materialize as file copies between the bots'
    // per-profile stores (the mailbox calls this on delivery).
    mailbox: {
      grantArtifacts: async (owner, from, to, ids) => {
        const base = artifactsDir();
        for (const id of ids) {
          copyArtifact(resolveInside(base, owner, from), resolveInside(base, owner, to), id);
        }
      },
    },
  });
  const mind = handle.mind;
  // One-time, repeatable: stored webhook tokens become hashes (URLs keep
  // working). Logs a count only, never a token.
  const sealed = await sealWebhookTokens(mind.converse);
  if (sealed > 0) console.log(`webhooks: sealed ${sealed} stored token(s) as hashes`);
  // One-time, repeatable: every pre-sign-in owner label (guest, or whatever
  // an older client sent) moves to the ONE account before anything listens.
  const migration = await migrateOwners(mind.converse, { to: OWNER_ID });
  const storageMove = migrateStorage({ to: OWNER_ID, from: migration.movedFrom });
  const movedRows =
    migration.sessions + migration.profiles + migration.tasks + migration.rooms + migration.mailbox;
  if (movedRows > 0 || storageMove.folders.length > 0) {
    console.log(
      `owners: moved ${movedRows} row(s), ${migration.conversationKeys} conversation key(s), ` +
        `${migration.memoryStores} memory store(s), ${storageMove.folders.length} folder(s) ` +
        `to ${OWNER_ID}${migration.movedFrom.length > 0 ? ` from ${migration.movedFrom.join(", ")}` : ""}`,
    );
    for (const move of storageMove.moves) console.log(`owners: ${move}`);
  }
  // The attention last-mile: dead-letters and disabled jobs must ARRIVE.
  wireEscalationPager(mind);
  // The live socket: task and approval changes are pushed as signals (the
  // same seams the web-push notifier listens on).
  const liveStops = [
    mind.tasks.listen(() => {
      liveHub.emit("tasks");
      liveHub.emit("needs-you");
    }),
    mind.approvals.listen(() => {
      liveHub.emit("approvals");
      liveHub.emit("needs-you");
    }),
    mind.mcp?.subscribe(() => liveHub.emit("connectors")),
    watchRunningTasks(mind, () => liveHub.emit("tasks")).stop,
  ];
  // Web Push to the owner's devices (inert until VAPID keys are in .env).
  const push = startPush(mind);
  let refreshSchedules: () => Promise<void> = async () => undefined;
  const scheduler: CronScheduler = await startScheduler(mind);
  refreshSchedules = () => scheduler.refresh();
  // Calendar sensors: the poll loop is server-side (clock + network); the
  // registry and the dedup rings are durable mind docs.
  const sensorLoop: SensorLoop = await startSensorLoop(mind);
  // The weekly memory tidy (Sundays 09:00 WIB; catches up on boot).
  const memoryTidy = startMemoryTidy({
    mind,
    notify: (owner, text) =>
      push.notifier
        .notify(owner, {
          title: text,
          body: "Open the Memory panel to review.",
          url: "/bots",
          tag: "memory-tidy",
        })
        .then(() => undefined),
  });
  const host = createHost<Principal>({ name: "server", self: { kind: "server" } });
  host.serve(Ping, (_input, _principal, self) => {
    const count = self.state("count", Type.Number(), 0);
    return {
      variant: "default",
      count,
      increment: async ({ by }, ctx) => {
        count.change(ctx, (n) => n + by);
      },
    };
  });
  serveSession(host, mind);

  const auth = new AuthStore();
  const http = createServer(createRestHandler({ mind, scheduler, push, auth }));
  // noServer: the http server's one upgrade handler routes by path (the
  // chord links here, the live event socket in slice 10).
  const wss = new WebSocketServer({ noServer: true });
  // The live event socket: coarse change signals only (docs/LIVE.md).
  const liveWss = liveConnections();
  liveWss.on("connection", (client) => liveHub.add(client));
  acceptWebSockets(wss, host, {
    principal: async (request) => {
      // The upgrade IS the credential check: no valid session, no link.
      const access = authorize(request, auth);
      return access.kind === "session" || access.kind === "bootstrap"
        ? principalOfAccount()
        : undefined;
    },
  });
  http.on("upgrade", (req, socket, head) => {
    // The handshake IS the credential check: no valid session, no upgrade.
    // (The chord principal callback below stays as the second layer.)
    const access = authorize(req, auth);
    if (access.kind === "refuse") {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === LIVE_PATH) {
      liveWss.handleUpgrade(req, socket, head, (client) => liveWss.emit("connection", client, req));
      return;
    }
    // Everything else is a chord link.
    wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
  });

  const close = async () => {
    for (const stop of liveStops) stop?.();
    push.stop();
    memoryTidy.stop();
    scheduler.stop();
    sensorLoop.stop();
    // Pending webhook windows first: a flush racing the mind's teardown
    // would otherwise write into a closed session.
    closeWebhookPump(mind);
    // Drop connected links first: wss.close() waits for clients otherwise, so
    // one live browser tab would block shutdown (and node --watch restarts) forever.
    for (const client of wss.clients) client.terminate();
    for (const client of liveWss.clients) client.terminate();
    await Promise.allSettled([
      new Promise<void>((resolve) => wss.close(() => resolve())),
      new Promise<void>((resolve) => http.close(() => resolve())),
    ]);
    await handle.close();
  };
  return { host, mind, http, scheduler, sensorLoop, close };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  // Unset HOST binds every interface, IPv4 AND IPv6 (Node's dual-stack `::`),
  // so localhost, 127.0.0.1, [::1], the LAN and the tailnet all reach it; HOST narrows it.
  const host = process.env.HOST === "" ? undefined : process.env.HOST;
  const stack = await buildStack();
  const ready = () =>
    console.log(`spriessen server listening on ${reachableUrls(stack.http, host).join("  ")}`);
  if (host === undefined) stack.http.listen(port, ready);
  else stack.http.listen(port, host, ready);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stack.close().then(() => process.exit(0));
    });
  }
}
