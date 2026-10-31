/**
 * One-time VAPID key generation: appends VAPID_PUBLIC_KEY and
 * VAPID_PRIVATE_KEY to the repo's .env when they are absent. Never prints a
 * key, never overwrites one (rotating keys silently orphans every device's
 * subscription). Run: `vpr @spreissen/server#push:keys`.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import webpush from "web-push";

const envPath = resolve(import.meta.dirname, "../../../.env");

const hasVar = (text: string, name: string): boolean =>
  new RegExp(`^\\s*${name}\\s*=\\s*\\S`, "m").test(text);

const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const havePublic = hasVar(current, "VAPID_PUBLIC_KEY");
const havePrivate = hasVar(current, "VAPID_PRIVATE_KEY");
if (havePublic && havePrivate) {
  console.log("VAPID keys already present in .env; nothing changed.");
} else if (havePublic !== havePrivate) {
  console.error("Only one VAPID key is set in .env; fix it by hand (remove both to regenerate).");
  process.exitCode = 1;
} else {
  const keys = webpush.generateVAPIDKeys();
  const lead = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(
    envPath,
    `${lead}\n# --- Web Push (generated once by push:keys; do not rotate casually) ---\n` +
      `VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`,
    { mode: 0o600 },
  );
  console.log("Added VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to .env (values not shown).");
}
