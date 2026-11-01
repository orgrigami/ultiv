/**
 * Secure-field secrets land in the right home (phase 4 slice 8): a key the
 * owner types for a DEPARTMENT connector is sealed as a vault item OF that
 * department, so the connector's home can redeem it; without a department
 * the item stays an org item (today's behaviour). Values never pass through
 * the model — the tool learns item ids and names only.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { homeOfItem, makeVaultStore, type VaultStore } from "@spriessen/ext";
import { makeSecretRequests, type SecretRequestsService } from "./requests.ts";

const OWNER = "owner-a";
const CONV = "conv-1";
const CALL_ID = "call-1";

describe("secure-field items carry the connector's home", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const setup = (): {
    secrets: SecretRequestsService;
    vault: VaultStore;
  } => {
    process.env.VAULT_KEY ??= "test-vault-key";
    const root = mkdtempSync(join(tmpdir(), "spriessen-secrets-"));
    dirs.push(root);
    const vault = makeVaultStore(join(root, "vault"));
    // A minimal approvals fake: the request approves at once. The test's
    // synchronous `submit` runs before ask's microtasks resume, so the
    // stored result is already on the waiting entry when it does.
    const approvals = {
      request: () => Effect.succeed(true),
      decide: () => undefined,
      noteFor: () => undefined,
      pendingFor: () => [{ callId: CALL_ID }] as unknown as never[],
    };
    const secrets = makeSecretRequests({
      approvals: approvals as unknown as Parameters<typeof makeSecretRequests>[0]["approvals"],
      vault,
      ownerOf: (conversationId) => (conversationId === CONV ? OWNER : undefined),
    });
    return { secrets, vault };
  };

  it("a department connector's key is sealed as an item OF that department", async () => {
    const { secrets, vault } = setup();
    const pending = secrets.ask(CONV, CALL_ID, {
      label: "OAuth client secret for Drive",
      purpose: "So Drive can connect.",
      fields: [{ key: "f0", label: "Client secret" }],
      departmentId: "alpha",
    });
    const submitted = secrets.submit(OWNER, CALL_ID, { f0: "gocsp-alpha-secret-0123456789" });
    expect(submitted.ok).toBe(true);
    const outcome = await pending;
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.stored).toHaveLength(1);
    const item = vault.get(OWNER, outcome.stored[0]?.itemId ?? "");
    expect(item?.name).toBe("OAuth client secret for Drive");
    // The stored item's HOME is the department, so only that home redeems it.
    expect(homeOfItem(item!)).toEqual({ kind: "department", departmentId: "alpha" });
  });

  it("without a department the item stays an org item", async () => {
    const { secrets, vault } = setup();
    const pending = secrets.ask(CONV, CALL_ID, {
      label: "OAuth client secret for Drive",
      purpose: "So Drive can connect.",
      fields: [{ key: "f0", label: "Client secret" }],
    });
    const submitted = secrets.submit(OWNER, CALL_ID, { f0: "gocsp-org-secret-0123456789" });
    expect(submitted.ok).toBe(true);
    const outcome = await pending;
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(homeOfItem(vault.get(OWNER, outcome.stored[0]?.itemId ?? "")!)).toEqual({ kind: "org" });
  });
});
