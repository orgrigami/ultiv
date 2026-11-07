/**
 * Template routes (slice 8): a team publishes a bot, a skill or an
 * Instructions file; another team copies it as its own — fresh
 * memory and chats, never vault items. Unpublishing stops new copies;
 * existing copies keep working. The list lives in the publishing
 * team's admin view; there is no global listing.
 */
import type { TemplateInfo, TemplatePayload } from "@spriessen/contracts";
import type { ProfileInfo } from "@spriessen/contracts";
import { may } from "./ask.ts";
import { errorOf, type RouteArgs } from "./types.ts";

/** One `permission` audit row for a template act. */
const audited = (args: RouteArgs, name: string): void => {
  args.mind.audit.record({
    at: Date.now(),
    kind: "permission",
    conversationId: "",
    profile: null,
    callId: null,
    name,
    durationMs: null,
    ok: true,
    error: null,
  });
};

/** The bot template payload: the definition and the two files, nothing else. */
const botPayload = async (args: RouteArgs, bot: ProfileInfo): Promise<TemplatePayload> => {
  const files = args.mind.profiles.files;
  const instructions = files !== undefined ? files.read(bot, "instructions").text : "";
  return {
    name: bot.name,
    persona: bot.persona,
    instructions,
  };
};

/** The skill template payload: SKILL.md and its reference files. */
const skillPayload = async (
  args: RouteArgs,
  owner: string,
  botId: string,
  skill: string,
): Promise<TemplatePayload | string> => {
  const detail = await args.mind.skills.read(owner, botId, skill);
  if (detail === undefined) return `unknown skill: ${skill}`;
  const files: Record<string, string> = { "SKILL.md": detail.body };
  for (const rel of detail.meta.files) {
    const text = await args.mind.skills.readFile(owner, botId, skill, rel);
    if (text !== undefined) files[rel] = text;
  }
  return { files };
};

export async function templateRoutes(args: RouteArgs): Promise<boolean> {
  const { req, mind, path, json, owner } = args;
  const method = req.method ?? "GET";

  if (path === "/api/org/templates" && method === "POST") {
    const body = await args.readJson<{
      kind?: string;
      teamId?: string;
      botId?: string;
      skill?: string;
      name?: string;
    }>(req);
    const kind = body.kind;
    if (
      (kind !== "bot" && kind !== "skill" && kind !== "instructions") ||
      body.teamId === undefined ||
      body.botId === undefined
    ) {
      json(400, { error: "kind (bot|skill|instructions), teamId and botId are required" });
      return true;
    }
    if (!(await may(args, "change", { type: "template", teamId: body.teamId }))) {
      json(404, { error: "unknown team" });
      return true;
    }
    const bot = await mind.profiles.get(owner, body.botId);
    if (bot === undefined || bot.teamId !== body.teamId) {
      json(404, { error: "unknown bot in this team" });
      return true;
    }
    let payload: TemplatePayload;
    let name: string;
    if (kind === "skill") {
      if (body.skill === undefined) {
        json(400, { error: "name the skill to publish" });
        return true;
      }
      const built = await skillPayload(args, owner, bot.id, body.skill);
      if (typeof built === "string") {
        json(404, { error: built });
        return true;
      }
      payload = built;
      name = body.skill;
    } else if (kind === "instructions") {
      const files = mind.profiles.files;
      payload = {
        text: files !== undefined ? files.read(bot, "instructions").text : "",
      };
      name = `${bot.name} instructions`;
    } else {
      payload = await botPayload(args, bot);
      name = bot.name;
    }
    const template: TemplateInfo = {
      id: crypto.randomUUID(),
      kind,
      name,
      teamId: body.teamId,
      payload,
      publishedAt: Date.now(),
      unpublishedAt: null,
    };
    await mind.org.putTemplate(template);
    audited(args, `template-published-${kind}`);
    json(200, template);
    return true;
  }

  if (path === "/api/org/templates" && method === "GET") {
    const team = args.url.searchParams.get("team") ?? args.url.searchParams.get("department");
    if (team === null) {
      json(400, { error: "team is required (the publisher's own list)" });
      return true;
    }
    if (!(await may(args, "view", { type: "template", teamId: team }))) {
      json(404, { error: "unknown team" });
      return true;
    }
    const view = await mind.org.view();
    json(
      200,
      view.templates.filter((row) => row.teamId === team && row.unpublishedAt === null),
    );
    return true;
  }

  const unpublish = path.match(/^\/api\/org\/templates\/([^/]+)$/);
  if (unpublish !== null && method === "DELETE") {
    const id = decodeURIComponent(unpublish[1] ?? "");
    const view = await mind.org.view();
    const template = view.templates.find((row) => row.id === id);
    if (template === undefined || template.unpublishedAt !== null) {
      json(404, { error: "unknown template" });
      return true;
    }
    if (!(await may(args, "change", { type: "template", teamId: template.teamId }))) {
      json(404, { error: "unknown template" });
      return true;
    }
    await mind.org.putTemplate({ ...template, unpublishedAt: Date.now() });
    audited(args, "template-unpublished");
    json(200, { ok: true });
    return true;
  }

  const copy = path.match(/^\/api\/org\/templates\/([^/]+)\/copy$/);
  if (copy !== null && method === "POST") {
    const id = decodeURIComponent(copy[1] ?? "");
    const body = await args.readJson<{ teamId?: string; botId?: string }>(req);
    if (body.teamId === undefined) {
      json(400, { error: "teamId (the target team) is required" });
      return true;
    }
    if (!(await may(args, "change", { type: "template", teamId: body.teamId }))) {
      json(404, { error: "unknown team" });
      return true;
    }
    const view = await mind.org.view();
    const template = view.templates.find((row) => row.id === id && row.unpublishedAt === null);
    if (template === undefined) {
      json(404, { error: "unknown template" });
      return true;
    }
    try {
      const created = await copyTemplate(args, template, body.teamId, body.botId);
      audited(args, `template-copied-${template.kind}`);
      json(200, created);
    } catch (cause) {
      json(400, { error: errorOf(cause) });
    }
    return true;
  }
  return false;
}

/**
 * Copy into the target team: a bot template spawns a new bot (fresh
 * memory and chats — the payload carries no memory, sessions or vault);
 * a skill or Instructions template installs onto a named bot of the target.
 */
const copyTemplate = async (
  args: RouteArgs,
  template: TemplateInfo,
  targetTeam: string,
  targetBot: string | undefined,
): Promise<unknown> => {
  const { mind, owner } = args;
  if (template.kind === "bot") {
    if (!("name" in template.payload)) throw new Error("template payload mismatch");
    const payload = template.payload as Extract<TemplatePayload, { name: string }>;
    const created = await mind.profiles.create(owner, {
      name: payload.name,
      persona: payload.persona,
      teamId: targetTeam,
      onboard: false,
    });
    // The bot's Instructions file gets the template's text (create seeds an
    // empty one; a template copy is not empty).
    const files = mind.profiles.files;
    if (files !== undefined && payload.instructions !== "") {
      files.save(created, "instructions", payload.instructions, {
        by: "owner",
        reason: `Copied from the ${template.name} template`,
      });
    }
    return created;
  }
  if (targetBot === undefined) {
    throw new Error("a skill or instructions copy needs botId (a bot of the target team)");
  }
  const bot = await mind.profiles.get(owner, targetBot);
  if (bot === undefined || bot.teamId !== targetTeam) {
    throw new Error("unknown bot in this team");
  }
  if (template.kind === "skill") {
    if (!("files" in template.payload)) throw new Error("template payload mismatch");
    const payload = template.payload as Extract<TemplatePayload, { files: Record<string, string> }>;
    const body = payload.files["SKILL.md"] ?? "";
    // SKILL.md IS the body; only the reference files ride the files list.
    const files = Object.entries(payload.files)
      .filter(([path]) => path !== "SKILL.md")
      .map(([path, content]) => ({ path, content }));
    return mind.skills.write(owner, targetBot, {
      name: template.name,
      body,
      note: `Copied from the ${template.name} template`,
      files,
      by: "owner",
    });
  }
  if (!("text" in template.payload)) throw new Error("template payload mismatch");
  const files = mind.profiles.files;
  if (files === undefined) throw new Error("bot files are not wired");
  const version = files.save(bot, "instructions", template.payload.text, {
    by: "owner",
    reason: `Copied from the ${template.name} template`,
  });
  return { ok: true, version: version?.n ?? null };
};
