import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProfilesService } from "../profiles/profiles.ts";
import { installTool } from "./install.ts";
import { skillsService } from "./service.ts";
import { gzOf, tarOf } from "./tar-test.ts";

const fixes = vi.hoisted(
  () =>
    ({ body: Buffer.alloc(0) as Buffer<ArrayBufferLike>, url: "https://skills.example/x" }) as {
      body: Buffer<ArrayBufferLike>;
      url: string;
    },
);

vi.mock("./fetch.ts", () => ({
  fetchBytes: async () => ({ url: fixes.url, body: Buffer.from(fixes.body), status: 200 }),
}));

let root: string | undefined;

const fresh = (): string => {
  root = mkdtempSync(join(tmpdir(), "ultiv-install-"));
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

const lastText = (result: { output?: readonly unknown[] } | undefined): string =>
  (result?.output?.at(-1) as { text?: string } | undefined)?.text ?? "";

describe("skill_install", () => {
  it("installs a tarball skill with its reference files", async () => {
    fresh();
    fixes.body = gzOf(
      tarOf(
        { path: "invoice/", typeflag: "5" },
        {
          path: "invoice/SKILL.md",
          content: "---\nname: invoice\ndescription: Invoicing steps\n---\n\n# steps",
        },
        { path: "invoice/references/codes.md", content: "VAT=21" },
      ),
    );
    const skills = skillsService({ root: root ?? "" });
    const tool = installTool(skills, profiles);
    const result = await tool?.execute(
      { url: "https://x/tar.gz" },
      { conversationId: "c1" } as never,
      {} as never,
    );
    expect(lastText(result)).toContain("installed");
    const detail = await skills.read("harry", "p1", "invoice");
    expect(detail?.meta.files).toEqual(["references/codes.md"]);
    expect(await skills.readFile("harry", "p1", "invoice", "references/codes.md")).toBe("VAT=21");
  });

  it("installs raw SKILL.md text and refuses a name that already exists", async () => {
    fresh();
    fixes.body = Buffer.from("---\nname: raw-skill\ndescription: From a raw URL\n---\n\n# raw");
    const skills = skillsService({ root: root ?? "" });
    const tool = installTool(skills, profiles);
    const first = await tool?.execute(
      { url: "https://x/SKILL.md" },
      { conversationId: "c1" } as never,
      {} as never,
    );
    expect(lastText(first)).toContain("installed");
    const second = await tool?.execute(
      { url: "https://x/SKILL.md" },
      { conversationId: "c1" } as never,
      {} as never,
    );
    // Same source URL: a reinstall is an update, not a collision.
    expect(lastText(second)).toContain("installed");
    fixes.url = "https://skills.example/other";
    fixes.body = Buffer.from("---\nname: raw-skill\ndescription: Collides\n---\n\n# x");
    const third = await tool?.execute(
      { url: "https://y/SKILL.md" },
      { conversationId: "c1" } as never,
      {} as never,
    );
    expect(lastText(third)).toContain("already exists");
  });
});
