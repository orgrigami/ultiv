/**
 * skill_install: the one door outside skills enter through, and it is gated
 * every time (the connector_* rule: never auto-approved). The fetch is
 * SSRF-guarded and size-capped; the fetched text must parse as a skill
 * before it lands, and it lands with its source stamped on it. Until the
 * owner approves the call, outside content stays data.
 */
import { Type } from "typebox";
import { defineTool, type Tool } from "@ultiv/ext";
import type { ProfilesService } from "../profiles/profiles.ts";
import { fetchText } from "./fetch.ts";
import { parseSkillDoc } from "./frontmatter.ts";
import { slugify, slugOk } from "./guard.ts";
import type { SkillsService } from "./service.ts";
import { skillsScope } from "./tools.ts";

/** skill_install: the gated door outside skills enter through. */
export const installTool = (skills: SkillsService, profiles: ProfilesService): Tool =>
  defineTool({
    name: "skill_install",
    gated: true,
    description:
      "Install a skill from a URL that serves a SKILL.md file's raw text (e.g. a GitHub raw " +
      "or gist URL). Your owner approves every install: say in one sentence what the skill " +
      "is for and where it comes from. After install it reads like any skill of yours, with " +
      "its source stamped on it. To refresh one you installed from the same URL, install it " +
      "again.",
    parameters: Type.Object({
      url: Type.String({ description: "https URL serving the SKILL.md text." }),
      name: Type.Optional(
        Type.String({ description: "Install under this name instead of the file's own." }),
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
      const fetched = await fetchText(args.url).catch((cause: unknown) => {
        throw new Error(cause instanceof Error ? cause.message : String(cause));
      });
      const doc = parseSkillDoc(fetched.text);
      if (doc === undefined) {
        return {
          output: [
            {
              type: "text" as const,
              text: "that URL did not serve a skill file (frontmatter with name and description required)",
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
        body: fetched.text,
        origin: "url",
        sourceUrl: fetched.url,
        authorProfile: profileId,
      });
      return {
        ...textResponse(
          `skill "${meta.name}" installed from ${fetched.url} (v${meta.version}); in your list next turn`,
        ),
        structuredOutput: { name: meta.name, version: meta.version },
      };
    },
  });

const textResponse = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
