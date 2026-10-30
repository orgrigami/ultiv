import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import type { ProfileCreate, ProfileInfo } from "@ultiv/contracts";
import { InvalidInput } from "@ultiv/core";
import type { AuditService } from "../audit/audit.ts";
import type { ApprovalsService } from "../approvals.ts";
import type { ProfilesService } from "./profiles.ts";
import { botCreateTools, createInputOf } from "./bot-create.ts";

const bot = (id: string, name: string): ProfileInfo => ({
  id,
  owner: "harry",
  name,
  description: "",
  persona: "",
  timezone: "Asia/Jakarta",
  model: null,
  toolAllowlist: null,
  policies: { canInitiate: ["*"], autoApprove: [] } as unknown as ProfileInfo["policies"],
  createdAt: 0,
  archivedAt: null,
});

const ultius = bot("p1", "Ultius");

/** A gate with a fixed verdict and an optional override riding the approval. */
const gateOf = (verdict: boolean, override?: unknown): ApprovalsService =>
  ({
    request: () => Effect.succeed(verdict),
    noteFor: () => undefined,
    overrideFor: () => override,
  }) as unknown as ApprovalsService;

const audit = { record: () => {} } as unknown as AuditService;

/** A profiles service that knows `main` and records what create() was given. */
const profilesOf = (main: string | null, failWith?: Error) => {
  const created: ProfileCreate[] = [];
  return {
    service: {
      profileOf: (conversationId: string) => (conversationId === "c1" ? ultius : undefined),
      mainOf: async () => main,
      create: async (_owner: string, input: ProfileCreate) => {
        if (failWith !== undefined) throw failWith;
        created.push(input);
        return { ...ultius, id: "new", name: input.name };
      },
    } as unknown as ProfilesService,
    created,
  };
};

const run = async (
  deps: { profiles: ProfilesService; approvals: ApprovalsService },
  args: object,
) => {
  const tool = botCreateTools({ ...deps, audit })[0];
  if (tool === undefined) throw new Error("missing bot_create");
  const result = (await tool.execute(
    args as never,
    { conversationId: "c1", callId: "k1" } as never,
    {} as never,
  )) as { output: { text: string }[]; isError?: boolean };
  return {
    text: result.output.map((part) => part.text).join(""),
    isError: result.isError === true,
  };
};

describe("createInputOf", () => {
  it("maps the card fields onto ProfileCreate; empty means default", () => {
    expect(createInputOf({ name: " Robinson " })).toEqual({ name: " Robinson " });
    expect(
      createInputOf({
        name: "R",
        title: " Helper ",
        persona: " be kind ",
        model: "kenari/x",
        effort: "high",
        sandbox: false,
      }),
    ).toEqual({
      name: "R",
      description: "Helper",
      persona: "be kind",
      model: { id: "kenari/x", effort: "high" },
      policies: expect.objectContaining({ sandbox: false }),
    });
  });
});

describe("bot_create", () => {
  it("refuses a non-main bot before any card", async () => {
    const { service } = profilesOf("someone-else");
    const { text, isError } = await run(
      { profiles: service, approvals: gateOf(true) },
      { name: "R" },
    );
    expect(isError).toBe(true);
    expect(text).toContain("only your owner's main bot can create bots");
  });

  it("creates with the proposed fields when approved", async () => {
    const { service, created } = profilesOf("p1");
    const { text, isError } = await run(
      { profiles: service, approvals: gateOf(true) },
      { name: "Robinson", title: " Research ", sandbox: true },
    );
    expect(isError).toBe(false);
    expect(text).toContain('created bot "Robinson" (id: new)');
    expect(created[0]).toEqual({ name: "Robinson", description: "Research" });
  });

  it("an approval's override replaces the proposal wholesale", async () => {
    const { service, created } = profilesOf("p1");
    await run(
      { profiles: service, approvals: gateOf(true, { name: "Mole", sandbox: false }) },
      { name: "Robinson" },
    );
    expect(created[0]?.name).toBe("Mole");
    expect(created[0]?.policies?.sandbox).toBe(false);
  });

  it("a deny answers the model with the act's standard refusal", async () => {
    const { service, created } = profilesOf("p1");
    const { text, isError } = await run(
      { profiles: service, approvals: gateOf(false) },
      { name: "R" },
    );
    expect(isError).toBe(true);
    expect(text).toContain("not approved");
    expect(created).toEqual([]);
  });

  it("a failed create (unknown model) comes back as a tool error the bot can relay", async () => {
    const { service } = profilesOf("p1", new InvalidInput({ reason: "unknown model: nope/x" }));
    const { text, isError } = await run(
      { profiles: service, approvals: gateOf(true) },
      { name: "R", model: "nope/x" },
    );
    expect(isError).toBe(true);
    expect(text).toContain("unknown model: nope/x");
  });
});
