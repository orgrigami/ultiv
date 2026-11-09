/**
 * The broker client's edges, against fake backends: a reply is the last
 * JSON line; a call the VM gives up on (its exec times out, the VM goes
 * away) comes back as a `timeout` refusal the tool can word, never a throw
 * that would surface as a crash in the bot's turn.
 */
import { describe, expect, it } from "vite-plus/test";
import type { ShellBackend } from "../shell/backend.ts";
import { brokerClient } from "./broker-client.ts";

const backend = (exec: ShellBackend["exec"]): ShellBackend => ({
  prepare: async () => undefined,
  exec,
  listFiles: async () => [],
  readFile: async () => new Uint8Array(),
});

describe("brokerClient", () => {
  it("reads the last JSON line as the reply", async () => {
    const client = brokerClient();
    const reply = await client.call(
      backend(async () => ({
        stdout: 'noise\n{"ok":true,"title":"A"}\n',
        stderr: "",
        exitCode: 0,
      })),
      { op: "status", bot: "b" },
    );
    expect(reply).toEqual({ ok: true, title: "A" });
  });

  it("turns an exec that timed out into a refusal, not a crash", async () => {
    const client = brokerClient();
    const reply = await client.call(
      backend(async () => {
        throw new Error("exec timed out after 120s");
      }),
      { op: "open", bot: "b", url: "https://x.example/" },
    );
    expect(reply).toMatchObject({ ok: false, kind: "timeout" });
    expect(String(reply.error)).toContain("short of memory");
  });
});
