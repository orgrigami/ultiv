/**
 * The terminal client against the REAL server stack on an ephemeral port:
 * the first passcode through the CLI's own call (loopback bootstrap), a
 * refused call without a cookie, the bot list and its main chat over REST,
 * and the chat itself over a chord link from Node — the Session's snapshot
 * loads, an input lands in the transcript, and the turn settles (offline,
 * no model is configured, so it settles as an error sentence, never a hang).
 * The link attaches before the socket opens: a hello `ws` emits with `open`
 * would otherwise be missed and chord would refuse the server's first ack.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { buildStack } from "@spriessen/server";
import { createApi, SignInRequired, type Api } from "./http.ts";
import { connectLink, watchSession, type SessionSnapshot } from "./session.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-cli-client-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");
process.env["BOT_FILES_DIR"] = join(scratch, "bot-files");
process.env["MODELS_DEV_URL"] = "off";

let stack: Awaited<ReturnType<typeof buildStack>>;
let api: Api;

beforeAll(async () => {
  stack = await buildStack({
    storage: new MemoryStorage(),
    vault: { dir: join(scratch, "vault") },
  });
  await new Promise<void>((resolve) => stack.http.listen(0, "127.0.0.1", resolve));
  const address = stack.http.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const server = `http://127.0.0.1:${port}`;
  const anonymous = createApi(server, undefined);
  expect(await anonymous.authStatus()).toMatchObject({ passcodeSet: false, bootstrap: true });
  await expect(anonymous.profiles()).rejects.toBeInstanceOf(SignInRequired);
  const cookie = await anonymous.setPasscode("cli-passcode-1");
  api = createApi(server, cookie);
  // A bot to talk to (the web's onboarding creates one the same way).
  await fetch(`${server}/api/profiles`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Wren", onboard: false }),
  });
});

afterAll(async () => {
  await stack.close();
  rmSync(scratch, { recursive: true, force: true });
});

const until = async (
  read: () => SessionSnapshot,
  done: (snapshot: SessionSnapshot) => boolean,
  ms = 10_000,
): Promise<SessionSnapshot> => {
  const start = Date.now();
  while (!done(read())) {
    if (Date.now() - start > ms) throw new Error(`timed out; last: ${JSON.stringify(read())}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return read();
};

describe("the terminal client", () => {
  it("signs in and reads the session status", async () => {
    expect(await api.authStatus()).toMatchObject({ passcodeSet: true, session: true });
  });

  it("lists bots and opens the main chat over chord; an input settles", async () => {
    const bots = await api.profiles();
    const wren = bots.find((bot) => bot.name === "Wren");
    expect(wren).toBeDefined();
    const chat = await api.mainChat(wren?.id ?? "");
    expect(chat.kind).toBe("main");
    const link = await connectLink(api.server, api.cookie ?? "");
    try {
      const ref = await link.open(chat.id);
      let snapshot: SessionSnapshot | undefined;
      const stop = watchSession(ref, (next) => (snapshot = next));
      const read = (): SessionSnapshot => snapshot as SessionSnapshot;
      await until(read, (s) => s?.loaded === true);
      await ref.input({ text: "hello from the terminal" });
      const settled = await until(
        read,
        (s) =>
          s.transcript.some((e) => e.kind === "input" && e.text === "hello from the terminal") &&
          s.phase !== "working" &&
          (s.lastError !== null || s.transcript.some((e) => e.kind === "output")),
      );
      expect(settled.lastError ?? "").not.toMatch(/^\{/); // a sentence, never a raw tag
      stop();
      ref.release();
    } finally {
      link.close();
    }
  }, 30_000);

  it("a chord link without a cookie is refused with the sign-in sentence", async () => {
    await expect(connectLink(api.server, "spriessen_session=nope")).rejects.toThrow(
      /spriessen login/,
    );
  });
});
