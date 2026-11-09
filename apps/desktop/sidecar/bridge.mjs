// The chord bridge: a Node sidecar that holds the real chord client (the same
// one apps/web uses) and relays Session state and actions to the desktop app
// over JSON lines on stdin/stdout. The Rust app owns this process.
//
//   stdin:  {"op":"attach","id":..} | {"op":"input","id","text"} |
//           {"op":"decide","id","callId","approved","always"} |
//           {"op":"interrupt","id"} | {"op":"configure","id","model","effort"} |
//           {"op":"retryQueued","id"} | {"op":"withdraw","id","queuedId"} |
//           {"op":"bye"}
//   stdout: {"op":"ready"} | {"op":"link","status":"live"|"lost"} |
//           {"op":"session","id",...state} | {"op":"error","message"}
//
// Deps resolve by walking up from this file: the workspace root's
// node_modules (dev) or the install's (~/.spriessen/sources). BRIDGE_MODULE_ROOT
// never needed — the walk-up reaches whichever checkout runs the app.

import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";
import { createHost, webSocketLink } from "@earendil-works/chord";
import WebSocket from "ws";

// The contracts are a workspace package: resolvable beside the server when
// the app runs from a checkout, never from a bare node_modules root.
let Session;
try {
  ({ Session } = await import("@spriessen/contracts"));
} catch {
  const apps = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const entry = path.join(
    apps,
    "server",
    "node_modules",
    "@spriessen",
    "contracts",
    "src",
    "index.ts",
  );
  ({ Session } = await import(pathToFileURL(entry).href));
}

const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const url = flag("url") ?? "ws://127.0.0.1:8787/chord";
const cookie = flag("cookie") ?? "";

const send = (line) => process.stdout.write(JSON.stringify(line) + "\n");

let socket = null;
let host = null;
let attempts = 0;
const refs = new Map(); // id -> SessionRef with unsubscribers
const pendingAttach = new Set(); // ids asked for before the link opened
const pendingInputs = {}; // words typed before their session's ref existed

function link() {
  socket = new WebSocket(url, { headers: { Cookie: cookie } });
  socket.addEventListener("open", () => {
    attempts = 0;
    host = createHost({ name: "desktop", self: { kind: "guest" }, kind: "client" });
    host.connect(webSocketLink(socket), { principal: { kind: "guest" } });
    send({ op: "link", status: "live" });
    for (const id of refs.keys()) reopen(id);
    const waiting = [...pendingAttach];
    pendingAttach.clear();
    for (const id of waiting) reopen(id);
    for (const id of refs.keys()) flushInputs(id);
  });
  socket.addEventListener("close", () => {
    for (const ref of refs.values()) release(ref);
    host = null;
    send({ op: "link", status: "lost" });
    const delay = Math.min(500 * 2 ** Math.min(attempts, 5), 10000);
    attempts += 1;
    setTimeout(link, delay);
  });
  socket.addEventListener("error", () => {
    // The close event follows; nothing else to do here.
  });
}

function release(ref) {
  for (const unsub of ref.__unsubs ?? []) {
    try {
      unsub();
    } catch {
      // A dead link has nothing left to unsubscribe.
    }
  }
  try {
    ref.release();
  } catch {
    // A ref on a dead link has nothing left to release.
  }
}

// The presentation lens: tool entries ride the web's own owner words.
let presentationOf = null;
async function loadLens() {
  try {
    ({ presentationOf } = await import("@spriessen/present/tool-text"));
  } catch {
    const apps = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const entry = path.join(
      apps,
      "server",
      "node_modules",
      "@spriessen",
      "present",
      "src",
      "tool-text.ts",
    );
    ({ presentationOf } = await import(pathToFileURL(entry).href));
  }
}

// Project one transcript entry for the Rust side: tool steps carry the
// presentation (hidden ones drop out), `react` becomes a reaction chip,
// everything else passes as is.
function project(entries) {
  if (!Array.isArray(entries)) return entries;
  return entries
    .map((entry) => {
      if (entry?.kind !== "tool") return entry;
      if (entry.step?.name === "react") {
        const details = entry.step?.details;
        if (details && typeof details === "object") {
          return {
            kind: "reaction",
            id: entry.id,
            reaction: details.reaction ?? details.name ?? "ok",
          };
        }
        return null;
      }
      if (presentationOf === null) return entry;
      const presentation = presentationOf(entry.step);
      if (presentation.kind === "hidden") return null;
      return { ...entry, presentation: presentation.view };
    })
    .filter((entry) => entry !== null);
}

async function reopen(id) {
  releaseOrForget(id);
  try {
    const opened = await host.get(Session, { id });
    // Chord cells are subscribe-only here (the web client never calls .get):
    // each cell's subscription fires with the current value, so hold the
    // latest of each and relay the whole picture on every fire.
    const latest = {
      transcript: [],
      phase: "idle",
      lastError: null,
      pending: null,
      usage: null,
      model: null,
      effort: null,
      conversationId: null,
      queued: [],
    };
    const record = { ref: opened, unsubs: [] };
    refs.set(id, record);
    flushInputs(id);
    const relay = () =>
      send({
        op: "session",
        id,
        loaded: latest.conversationId !== null,
        state: {
          transcript: project(latest.transcript),
          phase: latest.phase ?? "idle",
          lastError: latest.lastError ?? null,
          pending: latest.pending ?? null,
          usage: latest.usage ?? null,
          model: latest.model ?? null,
          effort: latest.effort ?? null,
          conversationId: latest.conversationId ?? null,
          queued: latest.queued ?? [],
        },
      });
    for (const [key, cell] of [
      ["transcript", opened.transcript],
      ["phase", opened.phase],
      ["lastError", opened.lastError],
      ["pending", opened.pending],
      ["usage", opened.usage],
      ["model", opened.model],
      ["effort", opened.effort],
      ["conversationId", opened.conversationId],
      ["queued", opened.queued],
    ]) {
      record.unsubs.push(
        cell.subscribe((value) => {
          latest[key] = value;
          relay();
        }),
      );
    }
  } catch (error) {
    send({ op: "error", message: `attach ${id}: ${error?.message ?? error}` });
  }
}

// Send the words that arrived before this session's ref existed.
async function flushInputs(id) {
  const held = pendingInputs[id];
  if (!held?.length) return;
  const ref = refs.get(id)?.ref;
  if (!ref) return;
  delete pendingInputs[id];
  for (const text of held) {
    try {
      await ref.input({ text });
    } catch (error) {
      send({ op: "error", message: `input ${id}: ${error?.message ?? error}` });
    }
  }
}

function releaseOrForget(id) {
  const record = refs.get(id);
  if (record) {
    release(record.ref);
    refs.delete(id);
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  handle(msg).catch((error) =>
    send({ op: "error", message: `${msg?.op}: ${error?.message ?? error}` }),
  );
});

async function handle(msg) {
  switch (msg.op) {
    case "attach": {
      const id = String(msg.id);
      if (host === null) {
        pendingAttach.add(id);
        return;
      }
      await reopen(id);
      return;
    }
    case "detach":
      releaseOrForget(String(msg.id));
      return;
    case "input": {
      const id = String(msg.id);
      const ref = refs.get(id)?.ref;
      if (!ref) {
        // The attach hasn't settled; hold the words like the web holds a
        // draft, and send them the moment the ref exists.
        (pendingInputs[id] ??= []).push(String(msg.text));
        return;
      }
      await ref.input({ text: String(msg.text) });
      return;
    }
    case "decide": {
      const ref = refs.get(String(msg.id))?.ref;
      const result = await ref?.approve({
        callId: String(msg.callId),
        approved: Boolean(msg.approved),
        ...(msg.always ? { always: true } : {}),
      });
      send({
        op: "decided",
        id: msg.id,
        callId: msg.callId,
        stored: result?.stored?.length ?? null,
      });
      return;
    }
    case "interrupt": {
      const ref = refs.get(String(msg.id))?.ref;
      await ref?.interrupt({});
      return;
    }
    case "configure": {
      const ref = refs.get(String(msg.id))?.ref;
      await ref?.configure({ model: msg.model ?? null, effort: msg.effort ?? null });
      return;
    }
    case "retryQueued": {
      const ref = refs.get(String(msg.id))?.ref;
      await ref?.retryQueued({});
      return;
    }
    case "withdraw": {
      const ref = refs.get(String(msg.id))?.ref;
      await ref?.withdraw({ id: String(msg.queuedId) });
      return;
    }
    case "bye":
      for (const id of [...refs.keys()]) releaseOrForget(id);
      socket?.close();
      process.exit(0);
      return;
    default:
      return;
  }
}

send({ op: "ready" });
loadLens().catch(() => {
  // Without the lens the tool rows still show their plain words.
});
link();
