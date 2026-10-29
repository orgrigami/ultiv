import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { skillsService } from "./service.ts";

let root: string | undefined;

const fresh = (): string => {
  root = mkdtempSync(join(tmpdir(), "ultiv-skills-"));
  return root;
};

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const BODY = (name: string, description: string, extra: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${extra}`;

describe("skills service over disk", () => {
  it("built-ins ride every listing and refuse writes", async () => {
    const skills = skillsService({ root: fresh() });
    const list = await skills.list("harry", "p1");
    const builtinNames = list.filter((meta) => meta.origin === "builtin").map((meta) => meta.name);
    expect(builtinNames).toEqual(["ultiv", "surfaces", "your-mind", "procedures"]);
    await expect(
      skills.write("harry", "p1", { name: "ultiv", body: BODY("ultiv", "d", "b") }),
    ).rejects.toThrow(/built-in/);
  });

  it("writes, rereads, bumps versions, reverts", async () => {
    const skills = skillsService({ root: fresh() });
    await skills.write("harry", "p1", {
      name: "invoice-run",
      body: BODY("invoice-run", "Weekly invoices", "# v1 steps"),
    });
    const second = await skills.write("harry", "p1", {
      name: "invoice-run",
      body: BODY("invoice-run", "Weekly invoices", "# v2 steps"),
    });
    expect(second.version).toBe(2);
    const detail = await skills.read("harry", "p1", "invoice-run");
    expect(detail?.body.includes("# v2 steps")).toBe(true);
    const reverted = await skills.revert("harry", "p1", "invoice-run");
    expect(reverted?.version).toBe(3);
    const after = await skills.read("harry", "p1", "invoice-run");
    expect(after?.body.includes("# v1 steps")).toBe(true);
  });

  it("refuses bad slugs, oversized bodies and secret-shaped text", async () => {
    const skills = skillsService({ root: fresh() });
    await expect(
      skills.write("harry", "p1", { name: "Bad_Name", body: BODY("x", "d", "b") }),
    ).rejects.toThrow(/not a skill name/);
    const oversized = `---\nname: big\ndescription: d\n---\n\n${"x".repeat(20_001)}`;
    await expect(skills.write("harry", "p1", { name: "big", body: oversized })).rejects.toThrow(
      /exceeds/,
    );
    const leaky = BODY("leaky", "d", "the key is sk-abcdef1234567890abcdef tonight");
    await expect(skills.write("harry", "p1", { name: "leaky", body: leaky })).rejects.toThrow(
      /secret/,
    );
  });

  it("proposals: reject leaves the skill, accept applies as a new version", async () => {
    const skills = skillsService({ root: fresh() });
    await skills.write("harry", "p1", {
      name: "triage",
      body: BODY("triage", "Morning triage", "# current"),
    });
    const rejected = await skills.propose("harry", "p1", {
      skill: "triage",
      body: BODY("triage", "Morning triage", "# rejected body"),
      note: "try a thing",
      byProfile: "p1",
    });
    await skills.decide("harry", "p1", rejected.id, "rejected");
    const untouched = await skills.read("harry", "p1", "triage");
    expect(untouched?.body.includes("# current")).toBe(true);
    expect(untouched?.body.includes("# rejected body")).toBe(false);
    const accepted = await skills.propose("harry", "p1", {
      skill: "triage",
      body: BODY("triage", "Morning triage", "# improved"),
      note: "clearly better",
      byProfile: "p1",
    });
    const verdict = await skills.decide("harry", "p1", accepted.id, "accepted");
    expect(verdict?.status).toBe("accepted");
    const after = await skills.read("harry", "p1", "triage");
    expect(after?.body.includes("# improved")).toBe(true);
    expect(after?.meta.parentVersion).toBe(1);
  });
});
