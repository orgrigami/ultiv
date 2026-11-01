/**
 * A per-home OAuth client (phase 4 slice 8): a department connector signs in
 * with ITS OWN client id and secret, redeemed at flow time from vault items
 * OF that department (never from config or tool arguments), against a local
 * mock endpoint. A connector whose home has no such items — including one
 * that names another home's items — falls back to today's mechanism
 * (dynamic client registration). No real Google sign-in happens here.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { startHttpFake, type HttpFake } from "./testing/http-fake.ts";
import { clientIdOf, clientSecretOf } from "./secrets.ts";
import { makeRig, remoteInput, waitFor, type Rig } from "./testing/rig.ts";
import type { McpServerRecord } from "./config.ts";

const OWNER = "owner-a";
const CALLBACK = "https://box.tailnet.ts.net/api/mcp/oauth/callback";
let rig: Rig | undefined;
let fake: HttpFake | undefined;

afterEach(async () => {
  await rig?.close();
  await fake?.close();
  rig = undefined;
  fake = undefined;
});

/** The "user" approves at the fake AS; return the callback's code and state. */
const approveAt = async (url: string) => {
  const response = await fetch(url, { redirect: "manual" });
  const location = new URL(response.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
  return {
    code: location.searchParams.get("code") ?? "",
    state: location.searchParams.get("state") ?? "",
  };
};

const DEPT_ID = "dept-x-client.apps.googleusercontent.com";
const ORG_ID = "org-client.apps.googleusercontent.com";
const DEPT_SECRET = "gocsp-dept-secret-0123456789";
const ORG_SECRET = "gocsp-org-secret-0123456789";

/** A bare record whose home (or lack of one) the caller sets. */
const recordOf = (id: string, slug: string, home?: string): McpServerRecord =>
  ({
    ...remoteInput("https://drivemcp.googleapis.com/mcp/v1", { name: slug }),
    id,
    owner: OWNER,
    slug,
    createdAt: 1,
    firstUseApproved: false,
    ...(home !== undefined ? { home } : {}),
  }) as McpServerRecord;

describe("a per-home OAuth client", () => {
  it("a department connector signs in with ITS OWN client id and secret", async () => {
    fake = await startHttpFake({ oauth: true, oauthRequireSecret: DEPT_SECRET });
    rig = makeRig();
    const { manager, vault } = rig;
    const idItem = vault.create(OWNER, {
      kind: "note",
      name: "Drive client id (dept x)",
      note: { secret: DEPT_ID },
      departmentId: "x",
    });
    const secretItem = vault.create(OWNER, {
      kind: "key",
      name: "Drive client secret (dept x)",
      key: { secret: DEPT_SECRET },
      departmentId: "x",
    });
    const added = manager.add(
      OWNER,
      remoteInput(`${fake.base}/mcp`, {
        auth: { kind: "oauth", clientIdItem: idItem.id, clientSecretItem: secretItem.id },
      }),
      // The connector belongs to department x; its client items too.
      "dept-x",
    );
    await waitFor(manager, OWNER, added.id, "needs_sign_in");
    const url = await manager.signIn(OWNER, added.id, CALLBACK);
    // The authorization redirect carries the DEPARTMENT's client id,
    // redeemed from the vault at flow time.
    expect(new URL(url ?? "").searchParams.get("client_id")).toBe(DEPT_ID);
    // A pre-registered client: no dynamic registration happened.
    expect(fake.auth.counts.registrations).toBe(0);
    const { code, state } = await approveAt(url ?? "");
    const info = await manager.finishSignIn(state, code);
    expect(info.signedIn).toBe(true);
    // The token exchange passed the department's secret (the mock refuses
    // any exchange without it); the connection is live.
    await waitFor(manager, OWNER, added.id, "connected");
  });

  it("a connector whose home has no such items falls back to dynamic registration", async () => {
    fake = await startHttpFake({ oauth: true });
    rig = makeRig();
    const { manager, vault } = rig;
    // Department x's client items; neither home may use the other's.
    const orgItemId = vault.create(OWNER, {
      kind: "note",
      name: "Drive client id (org)",
      note: { secret: ORG_ID },
    });
    const deptItemId = vault.create(OWNER, {
      kind: "note",
      name: "Drive client id (dept x)",
      note: { secret: DEPT_ID },
      departmentId: "x",
    });
    // A DEPARTMENT connector naming the ORG's item: the item reads as
    // absent, so the flow falls back to the mock's registration.
    const dept = manager.add(
      OWNER,
      remoteInput(`${fake.base}/mcp`, {
        name: "Dept drive",
        auth: { kind: "oauth", clientIdItem: orgItemId.id },
      }),
      "dept-x",
    );
    await waitFor(manager, OWNER, dept.id, "needs_sign_in");
    const deptUrl = await manager.signIn(OWNER, dept.id, CALLBACK);
    expect(new URL(deptUrl ?? "").searchParams.get("client_id")).not.toBe(ORG_ID);
    const { code, state } = await approveAt(deptUrl ?? "");
    expect((await manager.finishSignIn(state, code)).signedIn).toBe(true);
    await waitFor(manager, OWNER, dept.id, "connected");
    expect(fake.auth.counts.registrations).toBeGreaterThanOrEqual(1);
    // And the reverse: an ORG connector naming a DEPARTMENT's item also
    // falls back (the flow still completes, with the registered client).
    const org = manager.add(
      OWNER,
      remoteInput(`${fake.base}/mcp`, {
        name: "Org drive",
        auth: { kind: "oauth", clientIdItem: deptItemId.id },
      }),
    );
    await waitFor(manager, OWNER, org.id, "needs_sign_in");
    const orgUrl = await manager.signIn(OWNER, org.id, CALLBACK);
    expect(new URL(orgUrl ?? "").searchParams.get("client_id")).not.toBe(DEPT_ID);
    const orgApprove = await approveAt(orgUrl ?? "");
    expect((await manager.finishSignIn(orgApprove.state, orgApprove.code)).signedIn).toBe(true);
    await waitFor(manager, OWNER, org.id, "connected");
  });

  it("redemption refuses cross-home and profile-scoped items; a gone item stays an error", async () => {
    fake = await startHttpFake({ oauth: true });
    rig = makeRig();
    const { manager, vault } = rig;
    const org = recordOf("srv-org", "orgdrive");
    const dept = recordOf("srv-dept", "deptdrive", "dept-x");
    const orgIdItem = vault.create(OWNER, {
      kind: "note",
      name: "Org client id",
      note: { secret: ORG_ID },
    });
    const orgSecretItem = vault.create(OWNER, {
      kind: "key",
      name: "Org client secret",
      key: { secret: ORG_SECRET },
    });
    const deptIdItem = vault.create(OWNER, {
      kind: "note",
      name: "Dept client id",
      note: { secret: DEPT_ID },
      departmentId: "x",
    });
    const deptSecretItem = vault.create(OWNER, {
      kind: "key",
      name: "Dept client secret",
      key: { secret: DEPT_SECRET },
      departmentId: "x",
    });
    const profiledItem = vault.create(OWNER, {
      kind: "key",
      name: "A bot's own key",
      profile: "bot-1",
      key: { secret: "profile-scoped-secret" },
    });
    // Cross-home: a department connector vs the org's items, and an org
    // connector vs the department's items — both read as absent (undefined,
    // the fallback), never redeemed.
    expect(
      clientIdOf(vault, { ...dept, auth: { kind: "oauth", clientIdItem: orgIdItem.id } }),
    ).toBeUndefined();
    expect(
      clientSecretOf(vault, {
        ...dept,
        auth: { kind: "oauth", clientSecretItem: orgSecretItem.id },
      }),
    ).toBeUndefined();
    expect(
      clientIdOf(vault, { ...org, auth: { kind: "oauth", clientIdItem: deptIdItem.id } }),
    ).toBeUndefined();
    expect(
      clientSecretOf(vault, {
        ...org,
        auth: { kind: "oauth", clientSecretItem: deptSecretItem.id },
      }),
    ).toBeUndefined();
    // A profile-scoped item is not a home's client either.
    expect(
      clientIdOf(vault, { ...org, auth: { kind: "oauth", clientIdItem: profiledItem.id } }),
    ).toBeUndefined();
    // Each home DOES redeem its own items.
    expect(clientIdOf(vault, { ...org, auth: { kind: "oauth", clientIdItem: orgIdItem.id } })).toBe(
      ORG_ID,
    );
    expect(
      clientSecretOf(vault, {
        ...org,
        auth: { kind: "oauth", clientSecretItem: orgSecretItem.id },
      }),
    ).toBe(ORG_SECRET);
    expect(
      clientIdOf(vault, { ...dept, auth: { kind: "oauth", clientIdItem: deptIdItem.id } }),
    ).toBe(DEPT_ID);
    expect(
      clientSecretOf(vault, {
        ...dept,
        auth: { kind: "oauth", clientSecretItem: deptSecretItem.id },
      }),
    ).toBe(DEPT_SECRET);
    // A reference to an item that is gone entirely stays a plain error
    // (a broken setup, not a silent fallback), and Connect surfaces it.
    const thrown = (() => {
      try {
        clientSecretOf(vault, { ...org, auth: { kind: "oauth", clientSecretItem: "gone-item" } });
        return undefined;
      } catch (error) {
        return error as { reason?: string };
      }
    })();
    expect(thrown?.reason ?? "").toContain("the vault item is gone");
    const added = manager.add(
      OWNER,
      remoteInput(`${fake.base}/mcp`, {
        name: "Org drive",
        auth: { kind: "oauth", clientSecretItem: "gone-item" },
      }),
    );
    await waitFor(manager, OWNER, added.id, "failed");
    const cause = await manager.signIn(OWNER, added.id, CALLBACK).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((cause as { reason?: string }).reason ?? "").toContain("the vault item is gone");
  });
});
