import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ProfilesService } from "../profiles/profiles.ts";
import { skillsService } from "./service.ts";
import { renderSkills } from "./section.ts";
import { skillTools } from "./tools.ts";
import { evolveBrief } from "./evolve.ts";

let root: string | undefined;

const fresh = (): string => {
  root = mkdtempSync(join(tmpdir(), "spreissen-skills-tools-"));
  return root;
};

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const profiles = {
  scopeOf: () => ({ owner: "harry", profileId: "p1" }),
  profileOf: () => undefined,
} as unknown as ProfilesService;

const body = (extra: string): string =>
  `---\nname: triage\ndescription: Morning triage\n---\n\n${extra}`;

describe("skill tools", () => {
  it("write, list, load roundtrip; gated flags stay set", async () => {
    fresh();
    const byName = async (
      name: string,
    ): Promise<ReturnType<typeof skillTools>[number] | undefined> =>
      new Map(
        skillTools(skillsService({ root: root ?? "" }), profiles).map((registration) => [
          registration.name,
          registration,
        ]),
      ).get(name);
    const api = { conversationId: "c1" } as never;
    const ctx = {} as never;
    const write = (await byName("skill_write"))?.execute;
    const list = (await byName("skill_list"))?.execute;
    const load = (await byName("skill_load"))?.execute;
    const written = await write?.(
      { name: "triage", body: body("# v1"), description: "Morning triage" },
      api,
      ctx,
    );
    expect((written?.output?.at(-1) as { text?: string } | undefined)?.text).toContain("v1");
    const rows = await list?.({}, api, ctx);
    expect((rows?.output?.at(-1) as { text?: string } | undefined)?.text).toContain("triage");
    const loaded = await load?.({ name: "triage" }, api, ctx);
    expect((loaded?.output?.at(-1) as { text?: string } | undefined)?.text).toContain("# v1");
    expect((await byName("skill_delete"))?.gated).toBe(true);
  });

  it("refuses loading a disabled skill", async () => {
    fresh();
    const skills = skillsService({ root: root ?? "" });
    await skills.write("harry", "p1", { name: "triage", body: body("# v1") });
    await skills.setEnabled("harry", "p1", "triage", false);
    const load = skillTools(skills, profiles).find((tool) => tool.name === "skill_load");
    const result = await load?.execute(
      { name: "triage" },
      { conversationId: "c1" } as never,
      {} as never,
    );
    expect(result?.isError).toBe(true);
  });

  it("evolve briefs name the skill, its mode, and the cap", () => {
    const propose = evolveBrief({ skill: "triage", version: 2, mode: "propose", focus: "" });
    const apply = evolveBrief({ skill: "triage", version: 2, mode: "apply", focus: "the footer" });
    expect(propose).toContain('skill_propose "triage"');
    expect(propose).not.toContain("skill_write");
    expect(apply).toContain('skill_write "triage"');
    expect(apply).toContain("the footer");
    expect(propose).toContain("20000");
  });

  it("the prompt section caps its list and keeps the floor line", () => {
    const rows = Array.from({ length: 20 }, (_, at) => ({
      name: `skill-${at}`,
      description: `Skill number ${at}`,
      enabled: true,
      origin: "self",
    }));
    const rendered = renderSkills(rows);
    expect(rendered).toContain("You live in Spreissen");
    expect(rendered).toContain("…and 4 more");
    expect(renderSkills([])).toBe("");
    const disabled = renderSkills([
      { name: "x", description: "X", enabled: false, origin: "self" },
    ]);
    expect(disabled).toBe("");
  });
});
