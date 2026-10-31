/**
 * Chat privacy over the WebSocket (slice 4): the socket binds to the
 * signed-in account, and a Session attach resolves chats through THAT
 * account's key space. A session id belonging to another account's chat
 * never attaches to the other account's conversation — the attach lands on
 * a fresh conversation under the caller's own key instead.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { Session } from "@spriessen/contracts";
import { buildStack } from "./main.ts";
import type { Principal } from "./identity.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-ws-privacy-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");
process.env["MODELS_DEV_URL"] = "off";

let stack: Awaited<ReturnType<typeof buildStack>>;
let otherSession = "";
let otherConversation = "";

beforeAll(async () => {
  stack = await buildStack({ storage: new MemoryStorage() });
  await new Promise<void>((resolve, reject) => {
    stack.http.once("listening", resolve);
    stack.http.once("error", reject);
    stack.http.listen(0, "127.0.0.1");
  });
  // Another account's chat: a bot and its main session under a label that
  // is not the signed-in owner (throwaway; multi-account is a later phase).
  const bot = await stack.mind.profiles.create("someone-else", { name: "Else", onboard: false });
  const session = await stack.mind.profiles.ensureMain("someone-else", bot.id);
  otherSession = session.id;
  const key = await stack.mind.profiles.keyOfRow(session);
  otherConversation = String(
    await Effect.runPromise(stack.mind.converse.conversationIdOf(key as never)),
  );
});

afterAll(async () => {
  await stack.close();
  rmSync(scratch, { recursive: true, force: true });
});

const owner: Principal = { kind: "user", id: "owner" };
const intruder: Principal = { kind: "user", id: "someone-else" };

describe("chat privacy over the socket", () => {
  /** The attach hydrates in the background; wait for the id cell to land. */
  const waitForConversation = async (ref: {
    conversationId: { value: unknown; subscribe: (fn: (value: unknown) => void) => () => void };
  }): Promise<string> => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const value = ref.conversationId.value;
      if (value !== null && value !== undefined) return String(value);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return String(ref.conversationId.value);
  };

  it("the right account attaches its own chat", async () => {
    const ref = await stack.host.get(Session, { id: otherSession }, { principal: intruder });
    expect(await waitForConversation(ref)).toBe(otherConversation);
    ref.release();
  });

  it("another account naming the same id lands on a different conversation", async () => {
    const ref = await stack.host.get(Session, { id: otherSession }, { principal: owner });
    const conversationId = await waitForConversation(ref);
    expect(conversationId).not.toBe(otherConversation);
    expect(conversationId).not.toBe("");
    // And its transcript is empty: nothing of the other chat crossed.
    expect(ref.transcript.value).toEqual([]);
    ref.release();
  });
});
