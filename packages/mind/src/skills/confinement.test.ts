/** Skill files stay inside their skill folder: traversal and symlinks out are refused (temp dirs only). */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { skillsService } from "./service.ts";

let scratch = "";
afterEach(() => {
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});
const fresh = () => {
  scratch = mkdtempSync(join(tmpdir(), "spreissen-skill-confine-"));
  const root = join(scratch, "root");
  const outside = join(scratch, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.md"), "outside-only");
  return { root, outside, skills: skillsService({ root }) };
};
const BODY = "---\nname: demo\ndescription: d\n---\n\nbody";

describe("skill store confinement", () => {
  it("reads nothing through traversal or a symlink out", async () => {
    const { outside, skills } = fresh();
    await skills.write("owner-a", "p1", { name: "demo", body: BODY });
    expect(await skills.readFile("owner-a", "p1", "demo", "../../../../outside/secret.md")).toBe(
      undefined,
    );
    expect(await skills.readFile("owner-a", "p1", "demo", "/etc/passwd")).toBeUndefined();
    const detail = await skills.read("owner-a", "p1", "demo");
    expect(detail).toBeDefined();
    const dir = join(skills.root, "owner-a", "p1", "skills", "demo");
    symlinkSync(join(outside, "secret.md"), join(dir, "leak.md"));
    expect(await skills.readFile("owner-a", "p1", "demo", "leak.md")).toBeUndefined();
  });

  it("refuses owner or profile labels that climb out", async () => {
    const { skills } = fresh();
    await expect(skills.write("../x", "p1", { name: "demo", body: BODY })).rejects.toThrow();
    await expect(
      skills.write("owner-a", "../../x", { name: "demo", body: BODY }),
    ).rejects.toThrow();
  });
});
