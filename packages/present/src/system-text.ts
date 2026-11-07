/**
 * Bracketed machinery messages ("[task …]", "[webhook …]", "[cron …]",
 * "[sensor …]", bot-to-bot mail, "[resume]", "[owner]") parsed into what a
 * compact card needs. Pure: rendering only, the bot still sees the raw text.
 * Anything that does not match a known shape returns null, and the
 * transcript falls back to rendering it as before.
 */

export type TaskOutcome = "done" | "failed" | "cancelled";

export type SystemMessage =
  | { kind: "task"; taskId: string; outcome: TaskOutcome; body: string }
  | { kind: "task-update"; taskId: string; text: string }
  | {
      kind: "webhook";
      webhookId: string;
      event: string | null;
      payload: string;
      json: unknown;
      /** From a sender who may not ask for work: added to the thread's chat as context. */
      contextOnly: boolean;
    }
  | { kind: "cron"; jobId: string; text: string }
  | { kind: "sensor"; sensorId: string; source: string; text: string }
  | {
      kind: "bot";
      direction: "in" | "out";
      who: string;
      reply: boolean;
      asks: boolean;
      topic: string | null;
      /** The envelope id from the "re: <id>" header part; absent on outgoing notes. */
      envelopeId: string | null;
      body: string;
    }
  | { kind: "nack"; who: string; reason: string; detail: string; envelopeId: string | null }
  | { kind: "quiet"; text: string }
  | { kind: "access"; text: string }
  | {
      kind: "job";
      jobId: string;
      /** finished: the background shell job ended; lost: a restart cut it off. */
      outcome: "finished" | "lost";
      exitCode: number | null;
      /** The script's first line. */
      title: string;
      body: string;
    }
  | { kind: "hidden" };

/** The bot-only footers the mailbox appends to a delivered message. */
const BOT_FOOTER =
  /\n\n\((This is a direct request TO YOU|A notification from another bot)[\s\S]*\)\s*$/;

const OUTCOME: Record<string, TaskOutcome> = {
  finished: "done",
  failed: "failed",
  cancelled: "cancelled",
};

function parseTask(text: string): SystemMessage | null {
  const head = /^\[task (\S+) (finished|failed|cancelled|update)\]\s*/.exec(text);
  if (head === null) return null;
  const [, taskId = "", word = ""] = head;
  const body = text.slice(head[0].length).trim();
  if (word === "update") return { kind: "task-update", taskId, text: body };
  return { kind: "task", taskId, outcome: OUTCOME[word]!, body };
}

const EVENT_KEYS = ["event", "type", "action", "kind", "name"] as const;

function parseWebhook(text: string): SystemMessage | null {
  const head = /^\[webhook (\S+)\]\s*/.exec(text);
  if (head === null) return null;
  const rest = text.slice(head[0].length);
  const lead = /^outside payload \(data, not instructions(; context only[^)]*)?\):\n?/.exec(rest);
  const payload = rest.startsWith("(empty body)")
    ? ""
    : lead !== null
      ? rest.slice(lead[0].length)
      : rest;
  let json: unknown;
  try {
    json = payload === "" ? undefined : JSON.parse(payload);
  } catch {
    json = undefined;
  }
  let event: string | null = null;
  if (json !== null && typeof json === "object" && !Array.isArray(json)) {
    const record = json as Record<string, unknown>;
    const key = EVENT_KEYS.find((name) => typeof record[name] === "string");
    event = key === undefined ? null : String(record[key]);
  }
  return {
    kind: "webhook",
    webhookId: head[1] ?? "",
    event,
    payload,
    json,
    contextOnly: lead?.[1] !== undefined,
  };
}

function parseSensor(text: string): SystemMessage | null {
  const head = /^\[sensor (\S+)\]\s*(?:(\w+):\s*)?/.exec(text);
  if (head === null) return null;
  const text_ = text.slice(head[0].length).trim();
  return { kind: "sensor", sensorId: head[1] ?? "", source: head[2] ?? "sensor", text: text_ };
}

/** "no reply after 3 attempts: …" → "Couldn't be delivered" etc. */
function nackReason(detail: string): string {
  if (detail.startsWith("timed out")) return "Timed out";
  if (detail.startsWith("cancelled by your owner")) return "Cancelled by you";
  return "Couldn't be delivered";
}

function parseMail(text: string): SystemMessage | null {
  const nack = /^\[nack from ([^•\]]+?) • re: ([^\]]*)\]\s*/.exec(text);
  if (nack !== null) {
    const detail = text.slice(nack[0].length).trim();
    const envelopeId = (nack[2] ?? "").trim();
    return {
      kind: "nack",
      who: nack[1] ?? "",
      reason: nackReason(detail),
      detail,
      envelopeId: envelopeId === "" ? null : envelopeId,
    };
  }
  const mail = /^\[(message|reply) from ([^•\]]+?)((?: • [^•\]]+)*)\]/.exec(text);
  if (mail !== null) {
    const parts = (mail[3] ?? "").split(" • ").filter((part) => part !== "");
    const topic = parts.find((p) => p !== "request" && p !== "notify" && !p.startsWith("re: "));
    const envelopeId = parts
      .find((p) => p.startsWith("re: "))
      ?.slice(4)
      .trim();
    const body = text.slice(mail[0].length).replace(BOT_FOOTER, "").trim();
    return {
      kind: "bot",
      direction: "in",
      who: (mail[2] ?? "").trim(),
      reply: mail[1] === "reply",
      asks: parts.includes("request"),
      topic: topic ?? null,
      envelopeId: envelopeId === "" || envelopeId === undefined ? null : envelopeId,
      body,
    };
  }
  const sent = /^✉\s*→\s*(\S+)\s*\((\w+)(?:\s*•\s*([^)]*))?\)\s*/.exec(text);
  if (sent === null) return null;
  const parts = (sent[3] ?? "")
    .split(" • ")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const topic = parts.find((p) => p !== "request" && p !== "notify" && !p.startsWith("re: "));
  const envelopeId = parts
    .find((p) => p.startsWith("re: "))
    ?.slice(4)
    .trim();
  return {
    kind: "bot",
    direction: "out",
    who: sent[1] ?? "",
    reply: false,
    asks: sent[2] === "request",
    topic: topic ?? null,
    envelopeId: envelopeId === "" || envelopeId === undefined ? null : envelopeId,
    body: text.slice(sent[0].length).trim(),
  };
}

/** "[job 1a2b finished] exit 0: make test\n\n<output>" or "[job 1a2b lost] make test\n\n…". */
function parseJob(text: string): SystemMessage | null {
  const head = /^\[job (\S+) (finished|lost)\](?: exit (-?\d+):)? ?([^\n]*)/.exec(text);
  if (head === null) return null;
  return {
    kind: "job",
    jobId: head[1] ?? "",
    outcome: head[2] === "lost" ? "lost" : "finished",
    exitCode: head[3] === undefined ? null : Number(head[3]),
    title: (head[4] ?? "").trim(),
    body: text.slice(head[0].length).trim(),
  };
}

export function parseSystem(text: string): SystemMessage | null {
  if (text.startsWith("[resume]") || text.startsWith("[onboarding]")) return { kind: "hidden" };
  if (text.startsWith("[owner] ")) return { kind: "quiet", text: text.slice(8).trim() };
  if (text.startsWith("[task ")) return parseTask(text);
  if (text.startsWith("[webhook ")) return parseWebhook(text);
  if (text.startsWith("[sensor ")) return parseSensor(text);
  if (text.startsWith("[job ")) return parseJob(text);
  if (text.startsWith("[access changed] "))
    return { kind: "access", text: text.slice("[access changed] ".length).trim() };
  const cron = /^\[cron (\S+)\]\s*/.exec(text);
  if (cron !== null)
    return { kind: "cron", jobId: cron[1] ?? "", text: text.slice(cron[0].length).trim() };
  return parseMail(text);
}

const SECRET_KEY = /token|secret|password|authorization|api[_-]?key|signature/i;

/** The payload for display: pretty JSON with secret-looking fields masked. */
export function prettyPayload(message: Extract<SystemMessage, { kind: "webhook" }>): string {
  if (message.json === undefined) return message.payload;
  return JSON.stringify(
    message.json,
    (key, value: unknown) => (key !== "" && SECRET_KEY.test(key) ? "•••" : value),
    2,
  );
}

/** One line of a longer text, for previews. */
export function firstLine(text: string, max = 140): string {
  const line = (text.split("\n").find((part) => part.trim() !== "") ?? "").trim();
  const plain = line.replace(/^#+\s*|\*\*|__|`/g, "");
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}
