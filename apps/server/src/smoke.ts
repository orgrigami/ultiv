// Boots the full server stack on an ephemeral port, exercises the REST
// surface, and closes it cleanly — all offline and ephemeral (MemoryStorage).
// Run: vpr smoke  (root), or vp run --filter @ultiv/server smoke
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Session } from "@ultiv/contracts";
import { buildStack } from "./main.ts";
import { smokeMcp } from "./smoke-mcp.ts";

// The vault seals under this key for the smoke run only; the vault and the
// artifact workspace point at throwaway dirs so the run is hermetic.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VAULT_KEY = "smoke-vault-key";
const scratchVault = mkdtempSync(join(tmpdir(), "ultiv-smoke-vault-"));
const scratchArtifacts = mkdtempSync(join(tmpdir(), "ultiv-smoke-artifacts-"));
process.env.ARTIFACTS_DIR = scratchArtifacts;
// Skill stores stay hermetic too.
process.env.SKILLS_DIR = join(scratchArtifacts, "skills");
// Keep the audit trail hermetic: never append to a real var/audit.jsonl.
process.env.AUDIT_LOG = join(scratchArtifacts, "audit.jsonl");
// Connector configs land in the scratch dir too.
process.env.MCP_DIR = join(scratchArtifacts, "mcp");
// The model catalog never touches the network here: no models.dev fetch, a
// scratch cache, and one keyless local provider from an overlay. The default
// model stays unregistered, so onboarding turns fail fast as they always have.
process.env.MODELS_DEV_URL = "off";
process.env.MODELS_DEV_CACHE = join(scratchArtifacts, "models-dev.json");
process.env.MODELS_OVERLAY = join(scratchArtifacts, "models.local.json");
process.env.KENARI_MODELS_CACHE = join(scratchArtifacts, "kenari-models.json");
process.env.ULTIV_PROVIDERS = "smoke-local";
process.env.ULTIV_MODEL = "kenari/deepseek-v4-1-flash";
writeFileSync(
  process.env.MODELS_OVERLAY,
  JSON.stringify({
    "smoke-local": {
      name: "Smoke Local",
      npm: "@ai-sdk/openai-compatible",
      api: "http://127.0.0.1:9/v1",
      env: [],
      models: {
        tiny: { id: "tiny", name: "Tiny", tool_call: true, limit: { context: 8192, output: 1024 } },
      },
    },
  }),
);

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
const call = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
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
const failures: string[] = [];
const expect = (name: string, ok: boolean): void => {
  if (!ok) failures.push(name);
};

// The model catalog: overlay providers are listed as provider/model, offline.
const modelList = await call("GET", "/api/models");
expect(
  "overlay model listed",
  modelList.status === 200 &&
    modelList.json.some(
      (model: { id: string; providerName: string }) =>
        model.id === "smoke-local/tiny" && model.providerName === "Smoke Local",
    ),
);
const catalog = await call("GET", "/api/models/catalog");
expect(
  "catalog status offline",
  catalog.json?.source === "none" && catalog.json?.default === "kenari/deepseek-v4-1-flash",
);

// Fresh install: the workspace starts EMPTY — no default Ultius bot exists,
// and there is no main bot until the first one is spawned.
const freshProfiles = await call("GET", "/api/profiles", undefined, { "x-ultiv-user": "smoker" });
expect(
  "fresh install has no default bot",
  freshProfiles.status === 200 && freshProfiles.json.length === 0,
);
const freshMain = await call("GET", "/api/main", undefined, { "x-ultiv-user": "smoker" });
expect("fresh install has no main bot", freshMain.json.profileId === null);

// A bare session needs a bot to attach to: refused with the remedy.
const bareSession = await call(
  "POST",
  "/api/sessions",
  { title: "s" },
  {
    "x-ultiv-user": "smoker",
  },
);
expect(
  "bare session refused on empty workspace",
  bareSession.status === 400 && bareSession.json.error.includes("spawn a bot first"),
);
const bootBot = await call(
  "POST",
  "/api/profiles",
  // onboard: false — no seeded main chat, so owner-scoping counts stay exact.
  { name: "Boot", onboard: false },
  { "x-ultiv-user": "smoker" },
);
expect("profile create", bootBot.status === 200);

const created = await call(
  "POST",
  "/api/sessions",
  { title: "s", profileId: bootBot.json.id },
  { "x-ultiv-user": "smoker" },
);
expect("session create", created.status === 200 && created.json.owner === "smoker");
const mine = await call("GET", "/api/sessions", undefined, { "x-ultiv-user": "smoker" });
const others = await call("GET", "/api/sessions", undefined, { "x-ultiv-user": "someone-else" });
expect("owner scoping", mine.json.length === 1 && others.json.length === 0);

const upload = await fetch(`${base}/api/artifacts?name=smoke.md`, { method: "POST", body: "# ok" });
const artifact = (await upload.json()) as { id: string; mime: string };
expect("artifact upload", upload.status === 200 && artifact.mime === "text/markdown");
const raw = await fetch(`${base}/api/artifacts/${artifact.id}`);
expect("artifact download", raw.status === 200 && (await raw.text()) === "# ok");
const dl = await fetch(`${base}/api/artifacts/${artifact.id}?dl=1`);
expect(
  "artifact download disposition",
  dl.headers.get("content-disposition")?.startsWith("attachment") === true &&
    dl.headers.get("x-content-type-options") === "nosniff",
);
const meta = await fetch(`${base}/api/artifacts/${artifact.id}/meta`);
const metaJson = (await meta.json()) as { name: string; mime: string };
expect(
  "artifact meta",
  meta.status === 200 && metaJson.name === "smoke.md" && metaJson.mime === "text/markdown",
);
const missingMeta = await fetch(`${base}/api/artifacts/nope/meta`);
expect("artifact meta unknown", missingMeta.status === 404);

const hook = await call("POST", "/api/webhooks", { sessionId: created.json.id });
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
const schemaHook = await call("POST", "/api/webhooks", {
  sessionId: created.json.id,
  name: "deploys",
  schema: { type: "object", required: ["event"], properties: { event: { type: "string" } } },
});
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
const testOk = await call("POST", `/api/webhooks/${schemaHook.json.id}/test`, {
  payload: { event: "probe" },
});
const testBad = await call("POST", `/api/webhooks/${schemaHook.json.id}/test`, {
  payload: { nope: true },
});
expect(
  "test-fire validates schema",
  testOk.status === 200 && testOk.json.accepted === true && testBad.json.accepted === false,
);
// Fire receipts: ingress left durable evidence a lookup can find.
const receipts = await call(
  "GET",
  `/api/routines/events?routine=${schemaHook.json.id}`,
  undefined,
  { "x-ultiv-user": "smoker" },
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
const sensorsList = await call("GET", "/api/sensors", undefined, { "x-ultiv-user": "smoker" });
expect("sensor registry listed", sensorsList.status === 200 && Array.isArray(sensorsList.json));
const cron = await call("POST", "/api/cron", {
  sessionId: created.json.id,
  schedule: "*/5 * * * *",
  prompt: "tick",
});
expect(
  "cron create previews next fires",
  cron.status === 200 && Array.isArray(cron.json.next) && cron.json.next.length === 3,
);
expect(
  "cron create + delete",
  cron.status === 200 && (await call("DELETE", `/api/cron/${cron.json.id}`)).json.ok === true,
);

const task = await call("POST", "/api/tasks", { prompt: "background check" });
expect("task spawn", task.status === 200 && task.json.status === "running");
const audit = await call("GET", "/api/audit");
expect("audit tail", audit.status === 200 && Array.isArray(audit.json));

// Profiles: the workspace now contains exactly the bots that were spawned.
const headers = { "x-ultiv-user": "smoker" };
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
expect("profile create", researcher.status === 200 && researcher.json.owner === "smoker");
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
  headers,
});
const scopedArtifact = (await scopedUpload.json()) as { profile: string; owner: string };
expect(
  "artifact upload scoped",
  scopedUpload.status === 200 &&
    scopedArtifact.profile === rid &&
    scopedArtifact.owner === "smoker",
);
const scopedArtifacts = await call("GET", `/api/artifacts?profile=${rid}`, undefined, headers);
expect("artifact list by profile", scopedArtifacts.json.length === 1);

// Mailbox: human-instructed send is admitted; unknown targets refuse.
const cosProfile = await call("POST", "/api/profiles", { name: "CoS" }, headers);
const message = await call(
  "POST",
  `/api/profiles/${cosProfile.json.id}/messages`,
  { to: rid, kind: "request", body: "status?", topic: "smoke check" },
  headers,
);
expect("mailbox send admitted", message.status === 200 && message.json.status === "pending");
const refused = await call(
  "POST",
  `/api/profiles/${cosProfile.json.id}/messages`,
  { to: "nope", kind: "request", body: "x" },
  headers,
);
expect("mailbox refuses unknown target", refused.status === 400);
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
expect("room say", said.status === 200 && said.json.ok === true);

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

// Vault: secrets seal; responses carry masks only.
const login = await call(
  "POST",
  "/api/vault",
  {
    kind: "login",
    name: "Gmail",
    login: { url: "https://mail.google.com", username: "smoker@gmail.com", password: "hunter2" },
  },
  headers,
);
expect(
  "vault seals and masks",
  login.status === 200 &&
    login.json.masked.includes("smoker@gmail.com") &&
    !JSON.stringify(login.json).includes("hunter2"),
);
const vaultList = await call("GET", "/api/vault", undefined, headers);
expect("vault list metadata only", vaultList.status === 200 && vaultList.json.length === 1);

// Approvals inbox + memory.
const approvals = await call("GET", "/api/approvals", undefined, headers);
expect("approval inbox empty", approvals.status === 200 && approvals.json.length === 0);
const memoryWrite = await call("POST", "/api/memory", { text: "smoker prefers brevity" }, headers);
expect("owner memory write", memoryWrite.status === 200);
const memoryRead = await call("GET", "/api/memory", undefined, headers);
expect("owner memory read", memoryRead.json.length === 1);

// Connectors: added, used and removed on the running stack.
await smokeMcp(call, headers, expect);

// Skills: the built-in library lists for every bot; the owner can write,
// toggle, reread and remove one; sections pick it up on the next render.
const skillsOverview = await call("GET", "/api/skills", undefined, headers);
expect(
  "skills overview lists built-ins per bot",
  skillsOverview.status === 200 &&
    skillsOverview.json.builtins.length === 1 &&
    skillsOverview.json.profiles.length >= 1 &&
    skillsOverview.json.profiles[0].skills.length === 1,
);
const smokeSkillBody =
  "---\nname: smoke-skill\ndescription: A skill the smoke run wrote\n---\n\n# steps";
const skillPut = await call(
  "PUT",
  `/api/skills/${bootBot.json.id}/smoke-skill`,
  { body: smokeSkillBody },
  headers,
);
expect("owner skill write", skillPut.status === 200 && skillPut.json.version === 1);
const skillRead = await call(
  "GET",
  `/api/skills/${bootBot.json.id}/smoke-skill`,
  undefined,
  headers,
);
expect("owner skill reread", skillRead.status === 200 && skillRead.json.body.includes("# steps"));
const skillToggle = await call(
  "PUT",
  `/api/skills/${bootBot.json.id}/smoke-skill`,
  { enabled: false },
  headers,
);
expect("owner skill disable", skillToggle.status === 200 && skillToggle.json.enabled === false);
const skillDelete = await call(
  "DELETE",
  `/api/skills/${bootBot.json.id}/smoke-skill`,
  undefined,
  headers,
);
expect("owner skill delete", skillDelete.status === 200 && skillDelete.json.ok === true);

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
