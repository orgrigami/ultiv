/**
 * Local recovery: run ON THE HOST when the passcode is lost (or a session is
 * stuck). Resets the passcode and clears every sign-in session. The new
 * passcode is printed once; store it in the password manager.
 *
 *   vpr @spriessen/server#recover:access
 *   vpr @spriessen/server#recover:access -- --passcode "my own new code"
 *
 * The data (bots, chats, memory, vault) is untouched. Stop the server first
 * so the reset wins any write race, then start it again and sign in.
 */
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { makeAudit } from "@spriessen/mind";
import { authEvent } from "./auth/routes.ts";
import { AuthStore } from "./auth/store.ts";
import { dataPath } from "@spriessen/ext";

/** Reset the passcode (generated when not given) and drop all sessions. */
export const recoverAccess = (options?: { readonly passcode?: string }): string => {
  const passcode =
    options?.passcode !== undefined && options.passcode !== ""
      ? options.passcode
      : randomBytes(12).toString("base64url");
  new AuthStore().reset(passcode);
  // The recovery is an audit row in the same trail the server writes, so the
  // owner can see it happened (and when).
  try {
    const audit = makeAudit(
      process.env.AUDIT_LOG?.trim() !== "" && process.env.AUDIT_LOG !== undefined
        ? process.env.AUDIT_LOG
        : dataPath("audit.jsonl"),
    );
    audit.record(authEvent(Date.now(), "recovery", true));
  } catch {
    // An unwritable audit trail must not block regaining access.
  }
  return passcode;
};

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const flag = process.argv.indexOf("--passcode");
  const given = flag >= 0 ? process.argv[flag + 1] : undefined;
  const passcode = recoverAccess(given !== undefined ? { passcode: given } : {});
  console.log("passcode reset; every sign-in session was cleared.");
  console.log(`new passcode: ${passcode}`);
  console.log("Start the server and sign in with it. Keep it in your password manager.");
}
