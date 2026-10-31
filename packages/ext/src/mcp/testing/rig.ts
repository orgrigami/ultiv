/** Test-only helpers: a temp manager, server inputs, and waiting for a state. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerInfo, McpServerInput, McpState } from "@spreissen/contracts";
import { makeVaultStore, type VaultStore } from "../../vault.ts";
import { makeMcpConfigStore } from "../config.ts";
import { makeMcpManager, type McpManager } from "../manager.ts";

export const STDIO_SCRIPT = new URL("./stdio-server.ts", import.meta.url).pathname;

export const FAST_TUNING = {
  connectTimeoutMs: 5_000,
  backoffBaseMs: 50,
  backoffMaxMs: 200,
  restartLimit: 3,
  restartWindowMs: 5_000,
};

export const remoteInput = (
  url: string,
  overrides: Partial<McpServerInput> = {},
): McpServerInput => ({
  name: "Fake",
  transport: "auto",
  url,
  command: null,
  auth: { kind: "none" },
  profiles: null,
  enabled: true,
  autoAllowReadOnly: false,
  disabledTools: [],
  ...overrides,
});

export const stdioInput = (overrides: Partial<McpServerInput> = {}): McpServerInput => ({
  ...remoteInput("", overrides),
  transport: "stdio",
  url: null,
  command: { command: process.execPath, args: [STDIO_SCRIPT], env: [] },
  ...overrides,
});

export interface Rig {
  readonly root: string;
  readonly vault: VaultStore;
  readonly manager: McpManager;
  readonly close: () => Promise<void>;
}

export const makeRig = (): Rig => {
  process.env.VAULT_KEY ??= "test-vault-key";
  const root = mkdtempSync(join(tmpdir(), "spreissen-mcp-"));
  const vault = makeVaultStore(join(root, "vault"));
  const manager = makeMcpManager({
    config: makeMcpConfigStore(join(root, "mcp")),
    vault,
    vaultRoot: join(root, "vault"),
    reservedNames: () => new Set(["memory_write"]),
    tuning: FAST_TUNING,
  });
  return {
    root,
    vault,
    manager,
    close: async () => {
      await manager.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
};

/** Poll until the server reaches `state` (or fail after `ms`). */
export const waitFor = async (
  manager: McpManager,
  owner: string,
  id: string,
  state: McpState,
  ms = 8_000,
): Promise<McpServerInfo> => {
  const until = Date.now() + ms;
  for (;;) {
    const info = manager.info(owner, id);
    if (info?.state === state) return info;
    if (Date.now() > until) {
      throw new Error(`still ${info?.state ?? "missing"} (${info?.reason ?? ""}), wanted ${state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

export const textOf = (result: { content?: unknown }): string =>
  ((result.content ?? []) as { type: string; text?: string }[])
    .map((block) => block.text ?? "")
    .join("\n");
