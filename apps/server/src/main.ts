/**
 * Wires the mind (the platform's AI entity), the chord host, and the
 * WebSocket + HTTP + REST listeners. The app is thin: transport and registry
 * REST live here; every AI capability lives in @spriessen/mind.
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { acceptWebSockets, createHost } from "@earendil-works/chord";
import type { Storage } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { WebSocketServer, type WebSocket } from "ws";
import { Ping } from "@spriessen/contracts";
import { artifactsDir, copyArtifact, resolveInside, upgradeMcpHomes } from "@spriessen/ext";
import { httpPlugin } from "@spriessen/ext";
import { closeWebhookPump } from "./webhooks.ts";
import { agentEndpoint, AGENT_PATH } from "./agent.ts";
import { createNodeTransport, markAllNodesDisconnected } from "@spriessen/mind";
import { startSensorLoop, type SensorLoop } from "./sensors.ts";
import { startMemoryTidy, tidyPush } from "./memory-tidy.ts";
import { wireEscalationPager } from "./attention.ts";
import { startPush } from "./push/index.ts";
import {
  effectiveHostAccess,
  migrateOrg,
  migrateOwners,
  migrateShellTargets,
  openMind,
  sealWebhookTokens,
} from "@spriessen/mind";
import { migrateStorage } from "./auth/migrate-storage.ts";
import { OWNER_ID } from "./identity.ts";
import { can } from "./rest/can.ts";
import { purgeBot } from "./rest/bot-purge.ts";
import { startScheduler, type CronScheduler } from "./cron.ts";
import { principalOfAccount, type Principal } from "./identity.ts";
import { authorize } from "./auth/guard.ts";
import { coalesce, LIVE_PATH, liveConnections, liveHub, liveKindsForTool } from "./live.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { watchRunningTasks } from "./live-tasks.ts";
import { AuthStore } from "./auth/store.ts";
import { socketSessions } from "./auth/socket-sessions.ts";
import { createRestHandler } from "./rest.ts";
import { serveSession } from "./session.ts";
import { startServer } from "./start.ts";
import { staticHandler } from "./static.ts";

export type { Principal } from "./identity.ts";

/** When the boot warm-up of conversation search starts (after the boot rush). */
const SEARCH_WARMUP_MS = Number(process.env.SEARCH_WARMUP_MS ?? 60_000);

/**
 * Boots the whole stack: mind, chord host, cron scheduler, REST + WebSocket
 * listeners. `close()` stops the scheduler, drops links, then closes the
 * mind's scope (harness finalizers).
 */
export async function buildStack(options?: {
  readonly storage?: Storage;
  readonly vault?: { readonly dir?: string };
  /** A web build folder (apps/web/dist) the server serves itself (`spriessen serve`). */
  readonly webDist?: string;
}) {
  // The node agents' dial exists before the mind: openMind injects its exec
  // as the bash tool's `node` target transport (mind/node facade).
  const transport = createNodeTransport();
  const handle = await openMind({
    plugins: [httpPlugin],
    // Slice 4: the /agent exec dial behind the bash tool's node target.
    nodeExec: (nodeId, request) => transport.exec(nodeId, request),
    // The host capability (slice 11): the effective flag — org AND
    // department AND bot for a department bot, org AND bot for an org bot.
    // Rest takes the account check (see rest/can.ts).
    authz: {
      hostAccess: async (scope) => {
        const [view, profile] = await Promise.all([
          handle.mind.org.view(),
          scope.profileId === null
            ? Promise.resolve(undefined)
            : handle.mind.profiles.get(scope.owner, scope.profileId),
        ]);
        if (profile === undefined) return false;
        return effectiveHostAccess(view.org, view.departments, profile).allowed;
      },
      // The main bot's admin tools ask the one permission check; host-access
      // switches are not among them (the owner's alone, rest/can.ts).
      mayAdminister: async (scope) =>
        can(
          scope.owner,
          "change",
          { type: "bot-admin", caller: scope.profileId, main: scope.mainId },
          await handle.mind.org.view(),
        ),
      purgeBot: (owner, id) => purgeBot(handle.mind, owner, id),
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
  // One-time, repeatable: the merged bash tool's stored exact rules move to
  // their target form (`bash_host:=` → `bash@host:=`). Counts only, never a
  // script (they may carry secrets).
  const shellRules = await migrateShellTargets(mind.converse);
  if (shellRules > 0) console.log(`bash: migrated ${shellRules} stored host rule(s) to targets`);
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
  // One-time, repeatable: the workspace becomes the org ("Personal", owned
  // by the account); every existing bot becomes an org bot with host access
  // on. No department rows are created. Logs when it changed anything.
  const org = await migrateOrg(mind.converse, { owner: OWNER_ID });
  if (org.createdOrg || org.botsStamped > 0) {
    console.log(
      `org: created=${org.createdOrg} bots stamped ${org.botsStamped}, departments ${org.departments}`,
    );
  }
  // One-time, repeatable: MCP connector config moves from per owner to per
  // home (phase 4 slice 7) — existing connectors are stamped as the org's.
  // The org file's path is unchanged; a second run changes nothing.
  const stampedHomes = upgradeMcpHomes();
  if (stampedHomes > 0) {
    console.log(`mcp: moved ${stampedHomes} existing connector(s) to the org home`);
  }
  // What the migration could NOT move must be visible, not silent.
  if (migration.memorySkipped > 0) {
    console.warn(
      `owners: ${migration.memorySkipped} memory store(s) kept under the old label ` +
        `(the account already had content there); see docs/SECURITY.md`,
    );
  }
  for (const kept of storageMove.conflicts) {
    console.warn(`owners: kept under the old label (the account already has one): ${kept}`);
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
    // Bot-to-bot traffic never passes REST, so the mind signals it: one
    // coalesced "mailbox" frame per burst of envelope writes.
    mind.mailbox.listen(coalesce(() => liveHub.emit("mailbox"), 250)),
    // Eval runs save each graded case as it lands; one frame per burst.
    mind.evals.onChange(coalesce(() => liveHub.emit("evals"), 250)),
    mind.trials.onChange(coalesce(() => liveHub.emit("routines"), 250)),
    // A bot's project tool and the owner's edits both land here.
    mind.projects.onChange(coalesce(() => liveHub.emit("projects"), 250)),
    watchRunningTasks(mind, () => liveHub.emit("tasks")).stop,
    // What bots change through their tools never passes REST: the audit
    // record of each successful call names the slice to refresh.
    mind.audit.listen((event) => {
      if (event.kind !== "tool_call" || event.ok !== true) return;
      for (const kind of liveKindsForTool(String(event.name))) liveHub.emit(kind);
    }),
  ];
  // Web Push to the owner's devices (inert until VAPID keys are in .env).
  const push = startPush(mind);
  let refreshSchedules: () => Promise<void> = async () => undefined;
  let closing = false;
  const scheduler: CronScheduler = await startScheduler(mind);
  refreshSchedules = () => scheduler.refresh();
  // Calendar sensors: the poll loop is server-side (clock + network); the
  // registry and the dedup rings are durable mind docs.
  const sensorLoop: SensorLoop = await startSensorLoop(mind);
  // Conversation search warm-up: a minute after boot, index each bot's chats
  // once (only what is new), one bot at a time, so the first search on a
  // long history is not the one that waits. Never fails the boot.
  const warmSearch = setTimeout(() => {
    void (async () => {
      for (const profile of await mind.profiles.list(OWNER_ID)) {
        if (closing) return;
        await mind.history.index(OWNER_ID, profile.id).catch(() => 0);
      }
    })().catch(() => undefined);
  }, SEARCH_WARMUP_MS);
  warmSearch.unref();
  // The weekly memory tidy (Sundays 09:00 WIB; catches up on boot).
  const memoryTidy = startMemoryTidy({ mind, notify: tidyPush(push.notifier) });
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
  const sockets = socketSessions(auth);
  // The node agents' dial-in: the owner's machines authenticate with their
  // pairing token on the upgrade itself (no session cookie), so their path
  // routes BEFORE the session authorize in the upgrade handler below.
  const agents = agentEndpoint({ converse: mind.converse, transport });
  // No agent is dialed in before the server listens: a crash or kill left
  // the stored flags behind, so they reset here (reads use the live state).
  await markAllNodesDisconnected(mind.converse);
  const rest = createRestHandler({ mind, scheduler, push, auth, nodes: agents });
  const web = options?.webDist !== undefined ? staticHandler(options.webDist) : undefined;
  const http = createServer((req, res) => {
    if (web?.(req, res) !== true) rest(req, res);
  });
  // noServer: the http server's one upgrade handler routes by path (the
  // chord links here, the live event socket in slice 10).
  const wss = new WebSocketServer({ noServer: true });
  // The live event socket: coarse change signals only (docs/LIVE.md).
  const liveWss = liveConnections();
  liveWss.on("connection", (client) => liveHub.add(client));
  // Half-open sockets (a phone asleep, a network switch) are found and
  // dropped; /push also carries a heartbeat frame for the client's watchdog.
  const stopHeartbeat = startHeartbeat([wss, liveWss, agents.wss], () => liveHub.heartbeat());
  acceptWebSockets(wss, host, {
    principal: async (request) => {
      // The upgrade IS the credential check: no valid session, no link.
      const access = authorize(request, auth);
      return access.kind === "session" ? principalOfAccount() : undefined;
    },
  });
  http.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    // The node agents authenticate with their pairing token, not a session:
    // their path routes before the session authorize entirely.
    if (path === AGENT_PATH) {
      agents.handleUpgrade(req, socket, head);
      return;
    }
    // The handshake IS the credential check: no valid session, no upgrade.
    // (The chord principal callback below stays as the second layer.)
    const access = authorize(req, auth);
    if (access.kind === "refuse") {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Each open socket is tied to its session, so signing out closes it.
    const sessionId = access.kind === "session" ? access.sessionId : undefined;
    const tracked = (client: WebSocket): WebSocket => {
      if (sessionId !== undefined) sockets.track(client, sessionId);
      return client;
    };
    if (path === LIVE_PATH) {
      liveWss.handleUpgrade(req, socket, head, (client) =>
        liveWss.emit("connection", tracked(client), req),
      );
      return;
    }
    // Everything else is a chord link.
    wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", tracked(client), req));
  });

  const close = async () => {
    closing = true;
    clearTimeout(warmSearch);
    for (const stop of liveStops) stop?.();
    stopHeartbeat();
    agents.stop();
    sockets.stop();
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
  return {
    host,
    mind,
    http,
    scheduler,
    sensorLoop,
    sweepSockets: sockets.sweep,
    // The node agents' dial: tests (and future embedders) exec through the
    // transport and force a node's dial closed on revoke.
    nodeTransport: transport,
    nodes: agents,
    close,
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = await startServer(buildStack, { log: (line) => console.log(line) });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void server.close().then(() => process.exit(0));
    });
  }
}
