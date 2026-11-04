/**
 * Settings › Server's line about memory meaning search: off, on (where the
 * embedding model runs and what it is sent), or failing (the last error).
 */
import type { ServerCheck } from "./api-types.ts";

type Meaning = NonNullable<ServerCheck["meaning"]>;

export interface MeaningLine {
  readonly ok: boolean;
  readonly warn: boolean;
  readonly title: string;
  readonly detail: string;
}

export function meaningLine(
  meaning: Meaning | undefined,
  formatWhen: (at: number) => string,
): MeaningLine {
  if (meaning === undefined || meaning.model === null) {
    return {
      ok: true,
      warn: false,
      title: "Memory search by words",
      detail:
        "Bots find memories and past messages by their words. Set MEMORY_EMBEDDINGS (ollama, a provider/model, or openai-compatible) to also search by meaning.",
    };
  }
  const where = meaning.remote
    ? `${meaning.model}, off this machine: facts and messages are sent to it${meaning.tools ? ", tool results too" : "; tool results stay here"}.`
    : `${meaning.model}, on your own machine or network.`;
  const failing =
    meaning.lastError !== null &&
    meaning.lastErrorAt !== null &&
    (meaning.lastOkAt === null || meaning.lastErrorAt > meaning.lastOkAt);
  if (failing) {
    return {
      ok: false,
      warn: true,
      title: "Search by meaning is failing; words still work",
      detail: `${where} Last error ${formatWhen(meaning.lastErrorAt ?? 0)}: ${meaning.lastError}`,
    };
  }
  return {
    ok: true,
    warn: false,
    title: "Memory search by words and meaning",
    detail:
      meaning.lastOkAt === null
        ? `${where} Not used yet.`
        : `${where} Last worked ${formatWhen(meaning.lastOkAt)}.`,
  };
}
