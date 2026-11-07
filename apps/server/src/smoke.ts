// Boots the full server stack on an ephemeral port, exercises the REST
// surface, and closes it cleanly — all offline and ephemeral (MemoryStorage).
// Run: vpr smoke  (root), or vp run --filter @spriessen/server smoke
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Session } from "@spriessen/contracts";
import { buildStack } from "./main.ts";
import { smokeLate } from "./smoke-late.ts";
import { prepareSmokeEnv, smokeSignIn } from "./smoke-env.ts";

import { rmSync } from "node:fs";

const { scratchVault, scratchArtifacts } = prepareSmokeEnv();

const stack = await buildStack({ storage: new MemoryStorage(), vault: { dir: scratchVault } });
await new Promise<void>((resolve, reject) => {
  stack.http.once("listening", resolve);
  stack.http.once("error", reject);
  stack.http.listen(0, "127.0.0.1");
});
// The Session object must activate offline: its harness conversation is created lazily on first input.
const session = await stack.host.get(Session, { id: "smoke" });
session.release();

const address = stack.http.address();
const port = typeof address === "object" && address !== null ? address.port : address;
const base = `http://127.0.0.1:${port}`;
let cookie = "";
const call = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      // State changes always name JSON (typeless posts are refused).
      ...(body !== undefined || method !== "GET" ? { "content-type": "application/json" } : {}),
      cookie,
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })(),
  };
};

// REST surface: owner scoping, artifacts, webhook auth, cron validation.
cookie = await smokeSignIn(base);
const failures: string[] = [];
const expect = (name: string, ok: boolean): void => {
  if (!ok) failures.push(name);
};

// The model catalog: overlay providers are listed as provider/model, offline.
// The payload also carries the effective workspace default (env here).
const modelPayload = await call("GET", "/api/models");
const modelList = { json: modelPayload.json?.models };
expect(
  "overlay model listed",
  modelPayload.status === 200 &&
    modelList.json.some(
      (model: { id: string; providerName: string }) =>
        model.id === "smoke-local/tiny" && model.providerName === "Smoke Local",
    ),
);
expect(
  "models payload carries the env workspace default",
  modelPayload.json.workspaceDefault?.source === "env" &&
    modelPayload.json.workspaceDefault?.ref === "kenari/deepseek-v4-1-flash",
);
const catalog = await call("GET", "/api/models/catalog");
expect(
  "catalog status offline",
  catalog.json?.source === "none" && catalog.json?.default === "kenari/deepseek-v4-1-flash",
);

// Fresh install: the workspace starts EMPTY — no default Ultius bot exists,
// and there is no main bot until the first one is spawned.
const freshProfiles = await call("GET", "/api/profiles");
expect(
  "fresh install has no default bot",
  freshProfiles.status === 200 && freshProfiles.json.length === 0,
);
const freshMain = await call("GET", "/api/main", undefined, {});
expect("fresh install has no main bot", freshMain.json.profileId === null);

// A bare session needs a bot to attach to: refused with the remedy.
const bareSession = await call("POST", "/api/sessions", { title: "s" });
expect(
  "bare session refused on empty workspace",
  bareSession.status === 400 && bareSession.json.error.includes("spawn a bot first"),
);
const bootBot = await call(
  "POST",
  "/api/profiles",
  // onboard: false — no seeded main chat, so owner-scoping counts stay exact.
  { name: "Boot", onboard: false },
  {},
);
expect("profile create", bootBot.status === 200);

const created = await call("POST", "/api/sessions", { title: "s", profileId: bootBot.json.id }, {});
expect("session create", created.status === 200 && created.json.owner === "owner");
const mine = await call("GET", "/api/sessions");
const anonymous = await fetch(`${base}/api/sessions`);
expect(
  "owner scoping: mine listed, anonymous refused",
  mine.json.length === 1 && anonymous.status === 401,
);

const upload = await fetch(`${base}/api/artifacts?name=smoke.md`, {
  method: "POST",
  body: "# ok",
  headers: { cookie, "content-type": "application/octet-stream" },
});
const artifact = (await upload.json()) as { id: string; mime: string };
expect("artifact upload", upload.status === 200 && artifact.mime === "text/markdown");
const raw = await fetch(`${base}/api/artifacts/${artifact.id}`, { headers: { cookie } });
expect("artifact download", raw.status === 200 && (await raw.text()) === "# ok");
const dl = await fetch(`${base}/api/artifacts/${artifact.id}?dl=1`, { headers: { cookie } });
expect(
  "artifact download disposition",
  dl.headers.get("content-disposition")?.startsWith("attachment") === true &&
    dl.headers.get("x-content-type-options") === "nosniff",
);
const meta = await fetch(`${base}/api/artifacts/${artifact.id}/meta`, { headers: { cookie } });
const metaJson = (await meta.json()) as { name: string; mime: string };
expect(
  "artifact meta",
  meta.status === 200 && metaJson.name === "smoke.md" && metaJson.mime === "text/markdown",
);
const missingMeta = await fetch(`${base}/api/artifacts/nope/meta`, { headers: { cookie } });
expect("artifact meta unknown", missingMeta.status === 404);

// Binary uploads survive: raw bytes in, the same bytes back out.
const binaryBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);
const binaryUpload = await fetch(`${base}/api/artifacts?name=smoke.png&mime=image%2Fpng`, {
  method: "POST",
  body: binaryBytes,
  headers: { cookie, "content-type": "application/octet-stream" },
});
const binary = (await binaryUpload.json()) as { id: string };
expect("binary artifact upload", binaryUpload.status === 200);
const binaryRaw = await fetch(`${base}/api/artifacts/${binary.id}`, { headers: { cookie } });
const binaryBack = new Uint8Array(await binaryRaw.arrayBuffer());
expect(
  "binary artifact round-trip",
  binaryRaw.status === 200 &&
    binaryRaw.headers.get("content-type") === "image/png" &&
    binaryBack.length === binaryBytes.length &&
    binaryBack.every((byte, index) => byte === binaryBytes[index]),
);
const overCap = await fetch(`${base}/api/artifacts?name=big.bin`, {
  method: "POST",
  body: new Uint8Array(10_000_001),
  headers: { cookie, "content-type": "application/octet-stream" },
});
expect("upload cap 413", overCap.status === 413);

// Models expose their input modalities (vision badge / gate data).
const tiny = (modelList.json as { id: string; input?: string[] }[]).find(
  (model) => model.id === "smoke-local/tiny",
);
expect("models carry input modalities", tiny !== undefined && Array.isArray(tiny.input));
// A stored workspace default rides the payload labelled "db" (PUT round-trip below).
const storedPayload = await call("PUT", "/api/settings/model", { ref: "smoke-local/tiny" });
expect(
  "models payload carries a stored default as db",
  storedPayload.status === 200 &&
    (await call("GET", "/api/models")).json.workspaceDefault?.source === "db",
);
await call("PUT", "/api/settings/model", null);

const hook = await call("POST", "/api/webhooks", { sessionId: created.json.id }, {});
expect(
  "webhook create + bad token is 401",
  hook.status === 200 && (await call("POST", `/hooks/${hook.json.id}?token=x`, "b")).status === 401,
);
// The right token acks with a correlation id and leaves a fire receipt.
const hookAck = await fetch(`${base}/hooks/${hook.json.id}?token=${hook.json.token}`, {
  method: "POST",
  body: JSON.stringify({ ping: 1 }),
  headers: { "content-type": "application/json" },
});
const ackJson = (await hookAck.json()) as { ok: boolean; eventId: string };
expect(
  "webhook ack carries eventId",
  hookAck.status === 200 && ackJson.ok === true && typeof ackJson.eventId === "string",
);

// Schema gate: mismatched payloads are 422 pre-ack; matching ones pass.
const schemaHook = await call(
  "POST",
  "/api/webhooks",
  {
    sessionId: created.json.id,
    name: "deploys",
    schema: { type: "object", required: ["event"], properties: { event: { type: "string" } } },
  },
  {},
);
expect("webhook with schema", schemaHook.status === 200 && schemaHook.json.schema !== null);
const schemaReject = await call(
  "POST",
  `/hooks/${schemaHook.json.id}?token=${schemaHook.json.token}`,
  { wrong: 1 },
);
expect("schema mismatch is 422", schemaReject.status === 422);
const schemaAccept = await call(
  "POST",
  `/hooks/${schemaHook.json.id}?token=${schemaHook.json.token}`,
  { event: "deploy" },
);
expect("schema match is acked", schemaAccept.status === 200);
// Test-fire: the schema debugger — no delivery, receipted evidence.
const testOk = await call(
  "POST",
  `/api/webhooks/${schemaHook.json.id}/test`,
  { payload: { event: "probe" } },
  {},
);
const testBad = await call(
  "POST",
  `/api/webhooks/${schemaHook.json.id}/test`,
  { payload: { nope: true } },
  {},
);
// A webhook that is not on record answers exactly like a missing one.
const testUnknown = await call("POST", "/api/webhooks/no-such-hook/test", { payload: {} });
expect("webhook test-fire is owner-scoped", testUnknown.status === 404);
expect(
  "test-fire validates schema",
  testOk.status === 200 && testOk.json.accepted === true && testBad.json.accepted === false,
);
// Fire receipts: ingress left durable evidence a lookup can find.
const receipts = await call(
  "GET",
  `/api/routines/events?routine=${schemaHook.json.id}`,
  undefined,
  {},
);
expect(
  "routine receipts recorded",
  receipts.status === 200 &&
    Array.isArray(receipts.json) &&
    receipts.json.some((e: { status: string }) => e.status === "rejected") &&
    receipts.json.some((e: { status: string }) => e.status === "accepted"),
);

const badCron = await call("POST", "/api/cron", { sessionId: "s", schedule: "nope", prompt: "x" });
expect("cron rejects bad schedule", badCron.status === 400);
// Sensors: the registry answers even with no calendar configured (offline).
const sensorsList = await call("GET", "/api/sensors", undefined, {});
expect("sensor registry listed", sensorsList.status === 200 && Array.isArray(sensorsList.json));
const cron = await call(
  "POST",
  "/api/cron",
  { sessionId: created.json.id, schedule: "*/5 * * * *", prompt: "tick" },
  {},
);
expect(
  "cron create previews next fires",
  cron.status === 200 && Array.isArray(cron.json.next) && cron.json.next.length === 3,
);
// Trial mode: a schedule created as a trial can be paused, tried now (the
// trial lands on the job; offline it records why it could not run) and
// turned live.
const trialJob = await call(
  "POST",
  "/api/cron",
  { sessionId: created.json.id, schedule: "0 9 * * *", prompt: "email the team", trial: true },
  {},
);
expect("cron trial create", trialJob.status === 200 && trialJob.json.trial === true);
const paused = await call("PATCH", `/api/cron/${trialJob.json.id}`, { enabled: false }, {});
expect("cron pause", paused.status === 200 && paused.json.enabled === false);
const tried = await call("POST", `/api/cron/${trialJob.json.id}/try`, undefined, {});
expect("cron try now starts", tried.status === 202);
let triedJob: Record<string, unknown> | undefined;
for (let attempt = 0; attempt < 100 && triedJob === undefined; attempt += 1) {
  const jobs = (await call("GET", "/api/cron", undefined, {})).json as unknown as Record<
    string,
    unknown
  >[];
  triedJob = jobs.find(
    (job) => job.id === trialJob.json.id && Array.isArray(job.trials) && job.trials.length > 0,
  );
  if (triedJob === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
}
expect("cron trial recorded on the job", triedJob !== undefined);
const live = await call("PATCH", `/api/cron/${trialJob.json.id}`, { trial: false }, {});
expect("cron go live", live.status === 200 && live.json.trial === undefined);
await call("DELETE", `/api/cron/${trialJob.json.id}`, undefined, {});
expect(
  "cron create + delete",
  cron.status === 200 &&
    (await call("DELETE", `/api/cron/${cron.json.id}`, undefined, {})).json.ok === true,
);

const task = await call("POST", "/api/tasks", { prompt: "background check" });
expect("task spawn", task.status === 200 && task.json.status === "running");
const audit = await call("GET", "/api/audit", undefined, {});
expect("audit tail", audit.status === 200 && Array.isArray(audit.json));

// Profiles: the workspace now contains exactly the bots that were spawned.
const headers = {};
const profilesListed = await call("GET", "/api/profiles", undefined, headers);
expect(
  "profile list shows only spawned bots",
  profilesListed.status === 200 &&
    profilesListed.json.some((p: { id: string }) => p.id === bootBot.json.id),
);
const researcher = await call(
  "POST",
  "/api/profiles",
  { name: "Researcher", persona: "Careful." },
  headers,
);
expect("profile create", researcher.status === 200 && researcher.json.owner === "owner");
const rid = researcher.json.id as string;
const patched = await call("PATCH", `/api/profiles/${rid}`, { description: "deep dives" }, headers);
expect("profile patch", patched.status === 200 && patched.json.description === "deep dives");
// Per-bot model preference: durable on the profile, and applied to the bot's
// existing conversations (configure, not prompt-hacking).
const modelPatched = await call(
  "PATCH",
  `/api/profiles/${rid}`,
  { model: { id: "smoke-local/tiny", effort: "off" } },
  headers,
);
expect(
  "bot model preference sticks",
  modelPatched.status === 200 &&
    modelPatched.json.model?.id === "smoke-local/tiny" &&
    modelPatched.json.model?.effort === "off",
);
const unknownModel = await call(
  "PATCH",
  `/api/profiles/${rid}`,
  { model: { id: "nowhere/nothing", effort: "" } },
  headers,
);
expect("model outside the catalog refused", unknownModel.status === 400);
// Back to the workspace default (unregistered offline), so its turns fail fast.
const modelReset = await call("PATCH", `/api/profiles/${rid}`, { model: null }, headers);
expect("bot model resets to default", modelReset.status === 200 && modelReset.json.model === null);
// Approval mode: a per-key policies patch (what the chat-box switcher sends)
// flips the mode without clobbering the other policy keys.
const yoloPatched = await call(
  "PATCH",
  `/api/profiles/${rid}`,
  { policies: { approvalMode: "yolo" } },
  headers,
);
const yoloPolicies = yoloPatched.json?.policies;
expect(
  "approval mode patch to yolo keeps other policy keys",
  yoloPatched.status === 200 &&
    yoloPolicies?.approvalMode === "yolo" &&
    Array.isArray(yoloPolicies?.canInitiate) &&
    yoloPolicies.canInitiate.length > 0 &&
    typeof yoloPolicies?.approvalTimeout === "string" &&
    (yoloPolicies?.dailyTurnBudget === null || typeof yoloPolicies?.dailyTurnBudget === "number") &&
    typeof yoloPolicies?.memoryKeeper === "boolean",
);
const rereadPolicies = (await call("GET", `/api/profiles/${rid}`, undefined, headers)).json
  ?.policies;
expect("approval mode sticks on reread", rereadPolicies?.approvalMode === "yolo");
const badMode = await call(
  "PATCH",
  `/api/profiles/${rid}`,
  { policies: { approvalMode: "chaos" } },
  headers,
);
expect("unknown approval mode rejected", badMode.status === 400);
const restored = await call(
  "PATCH",
  `/api/profiles/${rid}`,
  { policies: { approvalMode: "manual" } },
  headers,
);
expect(
  "approval mode restored to manual",
  restored.status === 200 && restored.json.policies.approvalMode === "manual",
);
const mainAgain = await call("GET", `/api/profiles/${rid}/main`, undefined, headers);
const mainConv = await call("GET", `/api/sessions?profile=${rid}`, undefined, headers);
expect(
  "bot sessions still listed after model patch",
  mainAgain.status === 200 && Array.isArray(mainConv.json),
);
const main = await call("GET", `/api/profiles/${rid}/main`, undefined, headers);
expect("bot mode ensure", main.status === 200 && main.json.kind === "main");
const reset = await call("POST", `/api/profiles/${rid}/main/reset`, undefined, headers);
expect("bot mode reset rotates", reset.status === 200 && reset.json.id !== main.json.id);

const scoped = await call("POST", "/api/sessions", { title: "scoped", profileId: rid }, headers);
expect("session under profile", scoped.status === 200 && scoped.json.profile === rid);
const scopedList = await call("GET", "/api/sessions?profile=" + rid, undefined, headers);
expect(
  "sessions filter by profile",
  scopedList.json.some((s: { id: string }) => s.id === scoped.json.id),
);

// Artifacts partition per profile: uploads through a session land in its scope.
const scopedUpload = await fetch(`${base}/api/artifacts?name=note.md&sessionId=${scoped.json.id}`, {
  method: "POST",
  body: "# scoped",
  headers: { cookie, "content-type": "application/octet-stream" },
});
const scopedArtifact = (await scopedUpload.json()) as { profile: string; owner: string };
expect(
  "artifact upload scoped",
  scopedUpload.status === 200 && scopedArtifact.profile === rid && scopedArtifact.owner === "owner",
);
const scopedArtifacts = await call("GET", `/api/artifacts?profile=${rid}`, undefined, headers);
expect("artifact list by profile", scopedArtifacts.json.length === 1);

// Mailbox: bot talks are bot-to-bot only. Seed one as a bot's tool send
// (no model runs offline); a human cannot send into one over REST.
const cosProfile = await call("POST", "/api/profiles", { name: "CoS" }, headers);
const message = await stack.mind.mailbox.send({
  owner: "owner",
  from: cosProfile.json.id as string,
  to: rid,
  kind: "request",
  body: "status?",
  topic: "smoke check",
  origin: "tool",
});
expect("mailbox send admitted", message.status === "pending");
const humanSend = await call(
  "POST",
  `/api/profiles/${cosProfile.json.id}/messages`,
  { to: rid, kind: "request", body: "x" },
  headers,
);
expect("no human send into a bot talk", humanSend.status === 404);
const mailboxList = await call("GET", "/api/mailbox", undefined, headers);
expect("mailbox list", mailboxList.status === 200 && mailboxList.json.length >= 1);

// Rooms: the exchange lives in a contextual room with per-bot seats —
// never in either bot's session list.
await new Promise((resolve) => setTimeout(resolve, 300));
const roomsList = await call("GET", "/api/rooms", undefined, headers);
expect("room created for the exchange", roomsList.status === 200 && roomsList.json.length >= 1);
const roomId = roomsList.json[0].id as string;
const roomDetail = await call("GET", `/api/rooms/${roomId}`, undefined, headers);
expect(
  "room detail is one merged chat with participant names",
  roomDetail.status === 200 &&
    roomDetail.json.participants.length === 2 &&
    Array.isArray(roomDetail.json.timeline) &&
    roomDetail.json.participants.every((p: { name: string }) => typeof p.name === "string"),
);
const allSessions = await call("GET", "/api/sessions", undefined, headers);
expect(
  "rooms never appear in sessions",
  allSessions.json.every((row: { kind: string }) => row.kind !== "room"),
);
const said = await call(
  "POST",
  `/api/rooms/${roomId}/say`,
  { to: rid, text: "supervision ping" },
  headers,
);
expect("bot talks are read-only to humans", said.status === 404);
const cancelled = await call("POST", `/api/mailbox/${message.envelope.id}/cancel`, {}, headers);
expect("no human cancel in a bot talk", cancelled.status === 404);

// Main bot: the first spawned bot claims main automatically; it is
// switchable, one at a time, and not removable.
const mainFirst = await call("GET", "/api/main", undefined, headers);
expect("first bot became main", mainFirst.json.profileId === bootBot.json.id);
const deleteMain = await call("DELETE", `/api/profiles/${bootBot.json.id}`, undefined, headers);
expect("main bot protected", deleteMain.status === 409);
const setMain = await call("POST", `/api/profiles/${cosProfile.json.id}/main`, undefined, headers);
expect("set main", setMain.status === 200);
const mainAfter = await call("GET", "/api/main", undefined, headers);
expect("main switched", mainAfter.json.profileId === cosProfile.json.id);
const deleteOld = await call("DELETE", `/api/profiles/${rid}`, undefined, headers);
expect("non-main bot removable", deleteOld.status === 200 && deleteOld.json.ok === true);
const afterDelete = await call("GET", "/api/profiles", undefined, headers);
expect(
  "deleted bot stays deleted (no resurrection)",
  afterDelete.json.every((p: { id: string }) => p.id !== rid),
);

// Vault, approvals, memory, connectors, skills, tools, workspace default.
await smokeLate(call, headers, expect, bootBot.json.id as string);

if (failures.length > 0) {
  console.error(`smoke FAILED: ${failures.join(", ")}`);
  await stack.close();
  process.exit(1);
}
console.log(`smoke ok: stack exercised REST on 127.0.0.1:${port}`);
await stack.close();
rmSync(scratchVault, { recursive: true, force: true });
rmSync(scratchArtifacts, { recursive: true, force: true });
console.log("smoke ok: closed cleanly");
