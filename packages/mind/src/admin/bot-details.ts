/** `bot_details`' text: one bot's settings as the main bot reads them (never memory or chats). */
import type { ProfileInfo } from "@spriessen/contracts";
import { homeWords, orgOf, type AdminDeps } from "./common.ts";

const start = (text: string, max = 400): string => {
  const flat = text.trim();
  if (flat === "") return "(empty)";
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export const readBotDetails = async (deps: AdminDeps, bot: ProfileInfo): Promise<string> => {
  const view = await orgOf(deps).view();
  const mainId = await deps.profiles.mainOf(bot.owner);
  const instructions = deps.profiles.files?.read(bot, "instructions").text ?? "";
  const tools = bot.toolAllowlist === null ? "all installed tools" : bot.toolAllowlist.join(", ");
  return [
    `${bot.name} (id ${bot.id})${bot.id === mainId ? " (the main bot)" : ""}`,
    `Home: ${homeWords(bot.departmentId, view.departments, view.org?.name ?? "Personal")}`,
    `Role: ${bot.description.trim() === "" ? "(none)" : bot.description.trim()}`,
    `Model: ${bot.model === null ? "workspace default" : `${bot.model.id}${bot.model.effort !== "" ? ` (effort ${bot.model.effort})` : ""}`}`,
    `Tools: ${tools}`,
    `Sandbox: ${bot.policies.sandbox === false ? "off" : "on"}`,
    `Paused: ${bot.archivedAt === null ? "no" : "yes"}`,
    `Host access switch: ${bot.hostAccess === true ? "on" : "off"} (the owner's to change)`,
    `Persona: ${start(bot.persona)}`,
    `Instructions: ${start(instructions)}`,
  ].join("\n");
};
