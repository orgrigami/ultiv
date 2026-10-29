/**
 * skill_install: the one door outside skills enter through, and it is gated
 * every time (the connector_* rule: never auto-approved). Two forms: a URL
 * serving raw SKILL.md text, or a .tar.gz archive of a skill folder
 * (multi-file skills keep their references, scripts and assets). The fetch
 * is SSRF-guarded and size-capped; content must parse as a skill before it
 * lands, and it lands with its source stamped on it. Until the owner
 * approves the call, outside content stays data.
 */
import { Type } from "typebox";
import { defineTool, type Tool } from "@ultiv/ext";
import type { ProfilesService } from "../profiles/profiles.ts";
import { fetchBytes } from "./fetch.ts";
import { parseSkillDoc, type SkillDoc } from "./frontmatter.ts";
import { slugify, slugOk } from "./guard.ts";
import type { SkillsService } from "./service.ts";
import { skillsScope } from "./tools.ts";
import { extractSkill } from "./tarball.ts";

/** skill_install: the gated door outside skills enter through. */
export const installTool = (skills: SkillsService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "skill_install",
    gated: true,
    description:
      "Install a skill from outside, with your owner's approval (always asked). Two forms: a " +
      "https URL serving a SKILL.md file's raw text (GitHub raw, gists), or a .tar.gz archive " +
      "of a skill folder (GitHub codeload links work; use `path` when the archive holds " +
      "several folders). Multi-file skills keep their references, scripts and assets. " +
      "Installed skills carry their source URL, so reinstalling from the same URL updates " +
      "in place.",
    parameters: Type.Object({
      url: Type.String({
        description: "https URL: raw SKILL.md text, or a .tar.gz of a skill folder.",
      }),
      name: Type.Optional(
        Type.String({ description: "Install under this name instead of the file's own." }),
      ),
      path: Type.Optional(
        Type.String({
          description:
            'For archives: the folder inside holding SKILL.md (e.g. "my-skill", "skills/one"). ' +
            "Default: the shallowest folder containing SKILL.md.",
        }),
      ),
    }),
    structuredOutputSchema: Type.Object({ name: Type.String(), version: Type.Number() }),
    execute: async (args, api) => {
      const resolved = skillsScope(profiles, String(api.conversationId));
      if ("refused" in resolved) {
        return {
          output: [{ type: "text" as const, text: resolved.refused }],
          isError: true as const,
        };
      }
      const { owner, profileId } = resolved.scope;
      const fetched = await fetchBytes(args.url).catch((cause: unknown) => {
        throw new Error(cause instanceof Error ? cause.message : String(cause));
      });
      // Gzip magic bytes pick the archive path (unless the URL names a .md).
      const gzipped =
        fetched.body[0] === 0x1f && fetched.body[1] === 0x8b && !args.url.endsWith(".md");
      let doc: SkillDoc | undefined;
      let body: string;
      let files: readonly { path: string; content: string }[] | undefined;
      let skippedNote = "";
      if (gzipped) {
        const tar = extractSkill(fetched.body, args.path);
        doc = parseSkillDoc(tar.skillMd);
        body = tar.skillMd;
        files = tar.files;
        skippedNote =
          tar.skipped.length > 0
            ? `; skipped ${tar.skipped.length} binary or oversized file(s)`
            : "";
      } else {
        body = fetched.body.toString("utf8");
        doc = parseSkillDoc(body);
      }
      if (doc === undefined) {
        return {
          output: [
            {
              type: "text" as const,
              text: "that URL did not serve a skill (a SKILL.md with frontmatter, or an archive containing one)",
            },
          ],
          isError: true as const,
        };
      }
      const requested = args.name ?? doc.name;
      const name = slugOk(requested) ? requested : slugify(requested);
      const existing = await skills.read(owner, profileId, name);
      if (
        existing !== undefined &&
        !(existing.meta.origin === "url" && existing.meta.sourceUrl === fetched.url)
      ) {
        return {
          output: [
            {
              type: "text" as const,
              text: `a skill named "${name}" already exists (${existing.meta.origin}); pass \`name\` to install under another name`,
            },
          ],
          isError: true as const,
        };
      }
      const meta = await skills.write(owner, profileId, {
        name,
        body,
        ...(files !== undefined ? { files } : {}),
        origin: "url",
        sourceUrl: fetched.url,
        authorProfile: profileId,
      });
      return {
        ...textResponse(
          `skill "${meta.name}" installed from ${fetched.url} (v${meta.version})${skippedNote}; in your list next turn`,
        ),
        structuredOutput: { name: meta.name, version: meta.version },
      };
    },
  });

const textResponse = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
