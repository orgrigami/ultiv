// Boots a hermetic server stack on an ephemeral port for the desktop app's
// headless checks: scratch dirs everywhere, a passcode, one bot, and prints
// the connection JSON on one line. Dev-only; run from the repo root:
//   vp node apps/desktop/e2e/boot.ts
import { createRequire } from "node:module";
import { Session } from "../../../packages/contracts/src/index.ts";
import { buildStack } from "../../server/src/main.ts";
import { prepareSmokeEnv } from "../../server/src/smoke-env.ts";

// The same pi-durable copy the server resolves, not a second instance.
const serverRequire = createRequire(new URL("../../server/src/main.ts", import.meta.url));
const { MemoryStorage } = serverRequire("@earendil-works/pi-durable");

const env = prepareSmokeEnv();
const stack = await buildStack({ storage: new MemoryStorage(), vault: { dir: env.scratchVault } });
await new Promise<void>((resolve, reject) => {
  stack.http.once("listening", resolve);
  stack.http.once("error", reject);
  stack.http.listen(0, "127.0.0.1");
});
// The Session object must activate offline first, exactly as smoke.ts does.
const warm = await stack.host.get(Session, { id: "e2e" });
warm.release();
const address = stack.http.address();
const port = typeof address === "object" && address !== null ? address.port : address;
const base = `http://127.0.0.1:${port}`;

const json = "application/json";
const set = await fetch(`${base}/api/auth/passcode`, {
  method: "POST",
  headers: { "content-type": json },
  body: JSON.stringify({ passcode: "devdesktop" }),
});
if (!set.ok) throw new Error(`passcode: ${set.status}`);

const signIn = await fetch(`${base}/api/auth/sign-in`, {
  method: "POST",
  headers: { "content-type": json },
  body: JSON.stringify({ passcode: "devdesktop" }),
});
const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0];
if (!cookie) throw new Error("no cookie");

const bot = await (
  await fetch(`${base}/api/profiles`, {
    method: "POST",
    headers: { "content-type": json, cookie },
    body: JSON.stringify({
      name: "Sable",
      description: "The first bot; it answers and keeps the books.",
    }),
  })
).json();
const second = await (
  await fetch(`${base}/api/profiles`, {
    method: "POST",
    headers: { "content-type": json, cookie },
    body: JSON.stringify({ name: "Quill", description: "Files reports and watches the webhooks." }),
  })
).json();
const main = await (
  await fetch(`${base}/api/profiles/${bot.id}/main`, { headers: { cookie } })
).json();

console.log(
  `E2E ${JSON.stringify({ base, cookie, bot: bot.id, second: second.id, main: main.id })}`,
);
setInterval(() => {}, 10_000);
