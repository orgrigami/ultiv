/**
 * A bot's Persona and Instructions files (docs/BOT-FILES.md):
 * GET    /api/profiles/:id/files                    both files, current text + version
 * GET    /api/profiles/:id/files/:file/versions     the history, oldest first
 * PUT    /api/profiles/:id/files/:file              { text, reason? } saves a version
 * POST   /api/profiles/:id/files/:file/restore      { version } copies an old one forward
 * The caller already owns the bot (profileRoutes checks before calling in;
 * another owner's bot is the same 404 an unknown one is). A Persona save
 * goes through profiles.update, so the old field and every chat's copy
 * follow; Instructions are read per request, so the next turn sees them.
 * Each version records who saved it and when, so no audit line is added.
 */
import type { ProfileInfo } from "@spreissen/contracts";
import { BOT_FILE_LIMITS, isBotFile, type BotFile } from "@spreissen/mind";
import type { RouteArgs } from "./types.ts";

const view = (args: RouteArgs, bot: ProfileInfo, file: BotFile) => {
  const files = args.mind.profiles.files;
  return files === undefined ? { text: "", version: 0 } : files.read(bot, file);
};

export async function botFileRoutes(
  args: RouteArgs,
  bot: ProfileInfo,
  rest: string,
): Promise<boolean> {
  const { req, json, mind } = args;
  const method = req.method ?? "GET";
  if (!rest.startsWith("/files")) return false;
  const files = mind.profiles.files;
  if (files === undefined) {
    json(503, { error: "bot files are not set up" });
    return true;
  }
  if (rest === "/files" && method === "GET") {
    json(200, {
      persona: view(args, bot, "persona"),
      instructions: view(args, bot, "instructions"),
    });
    return true;
  }
  const match = rest.match(/^\/files\/([a-z]+)(\/versions|\/restore)?$/);
  const file = match?.[1];
  if (match === null || !isBotFile(file)) {
    json(404, { error: "unknown file" });
    return true;
  }
  const tail = match[2] ?? "";
  if (tail === "/versions" && method === "GET") {
    json(200, [...files.history(bot, file)].reverse());
    return true;
  }
  if (tail === "" && method === "PUT") {
    const body = await args.readJson<{ text?: unknown; reason?: unknown }>(req);
    if (typeof body.text !== "string" || body.text.length > BOT_FILE_LIMITS[file]) {
      json(400, { error: `text must be at most ${BOT_FILE_LIMITS[file]} characters` });
      return true;
    }
    const reason =
      typeof body.reason === "string" && body.reason.trim() !== "" ? body.reason : "Edited";
    if (file === "persona") {
      await mind.profiles.update(
        args.owner,
        bot.id,
        { persona: body.text },
        { by: "owner", reason },
      );
    } else {
      files.save(bot, file, body.text, { by: "owner", reason });
    }
    json(200, view(args, bot, file));
    return true;
  }
  if (tail === "/restore" && method === "POST") {
    const body = await args.readJson<{ version?: unknown }>(req);
    const old = files.history(bot, file).find((entry) => entry.n === body.version);
    if (old === undefined) {
      json(404, { error: "unknown version" });
      return true;
    }
    const meta = { by: "owner" as const, reason: `Restored version ${old.n}`, restoredFrom: old.n };
    if (file === "persona")
      await mind.profiles.update(args.owner, bot.id, { persona: old.text }, meta);
    else files.save(bot, file, old.text, meta);
    json(200, view(args, bot, file));
    return true;
  }
  json(405, { error: "method not allowed" });
  return true;
}
