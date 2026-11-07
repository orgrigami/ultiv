/**
 * `spriessen bots`: the crew (the main bot marked *), `bots new` to create
 * one (the first bot becomes the main bot, and a new bot introduces itself
 * in its first chat unless `--quiet`), `bots main` to choose which bot the
 * commands and the UI open when none is named.
 */
import type { ProfileCreate } from "@spriessen/contracts";
import { boolFlag, stringFlag, type Parsed } from "../args.ts";
import { clip, paintFor, print } from "../render/out.ts";
import { apiFor, liveBots, matchBot } from "./context.ts";

const list = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  const [bots, main] = await Promise.all([liveBots(api), api.main()]);
  const paint = paintFor();
  const width = Math.max(8, ...bots.map((bot) => bot.name.length)) + 2;
  print(parsed, bots, () =>
    bots.length === 0
      ? ["No bots yet. Create the first one: spriessen bots new <name>"]
      : [
          ...bots.map((bot) => {
            const star = bot.id === main.profileId ? paint.amber("*") : " ";
            const model = bot.model !== null ? paint.dim(` · ${bot.model.id}`) : "";
            return `${star} ${bot.name.padEnd(width)}${clip(bot.description, 60)}${model}`;
          }),
          "",
          paint.dim("* the main bot: spriessen and ask open it when no --bot is given"),
        ],
  );
};

const create = async (parsed: Parsed): Promise<void> => {
  const name = parsed.positionals.slice(2).join(" ").trim();
  if (name === "") {
    throw new Error('usage: spriessen bots new <name> [--description "…"] [--persona "…"]');
  }
  const api = apiFor(parsed);
  const description = stringFlag(parsed, "description");
  const persona = stringFlag(parsed, "persona");
  const model = stringFlag(parsed, "model");
  const chosen =
    model === undefined
      ? undefined
      : (await api.models()).models.find((candidate) => candidate.id === model);
  if (model !== undefined && chosen === undefined) {
    throw new Error(`${model} isn't a model here (see: spriessen models)`);
  }
  const input: ProfileCreate = {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(persona !== undefined ? { persona } : {}),
    ...(chosen !== undefined ? { model: { id: chosen.id, effort: chosen.defaultEffort } } : {}),
    ...(boolFlag(parsed, "quiet") ? { onboard: false } : {}),
  };
  const bot = await api.createProfile(input);
  const [main, models] = await Promise.all([api.main(), api.models()]);
  if (boolFlag(parsed, "json")) return console.log(JSON.stringify(bot, null, 2));
  console.log(
    `Created ${bot.name}${main.profileId === bot.id ? ", your main bot" : ""}.` +
      (boolFlag(parsed, "quiet") ? "" : " It is saying hello in its first chat."),
  );
  if (bot.model === null && models.workspaceDefault === null) {
    console.log(
      paintFor().amber(
        "It has no model yet, so it can't answer: spriessen models default <id> (see: spriessen models)",
      ),
    );
  }
  console.log(
    paintFor().dim(
      main.profileId === bot.id
        ? "Talk to it: spriessen"
        : `Talk to it: spriessen chat --bot ${JSON.stringify(bot.name)}`,
    ),
  );
};

const setMain = async (parsed: Parsed): Promise<void> => {
  const wanted = parsed.positionals.slice(2).join(" ").trim();
  if (wanted === "") throw new Error("usage: spriessen bots main <name>");
  const api = apiFor(parsed);
  const bot = matchBot(await liveBots(api), wanted);
  await api.setMain(bot.id);
  console.log(`${bot.name} is now the main bot.`);
};

export const botsCommand = async (parsed: Parsed): Promise<void> => {
  const sub = parsed.positionals[1];
  if (sub === undefined) return list(parsed);
  if (sub === "new") return create(parsed);
  if (sub === "main") return setMain(parsed);
  throw new Error(
    `\`spriessen bots ${sub}\` isn't a thing; try: bots, bots new <name>, bots main <name>`,
  );
};
