/**
 * Machinery notes in a transcript (bot-to-bot mail, relays) carry headers
 * written for the bot: "[message from Eve • topic • notify • re: <id>]" or
 * "✉ → <bot id> (request • topic)". For the owner they read as
 * "Message from Eve · topic" / "Message to Lucas · topic", with ids and the
 * bot-facing reply instructions dropped.
 */

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** The bot-only footers mailbox.ts appends to a delivered message. */
const BOT_FOOTER =
  /\n\n\((This is a direct request TO YOU|A notification from another bot)[\s\S]*\)\s*$/;

export interface Note {
  header: string;
  body: string;
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase("en") + text.slice(1);

function splitNote(text: string): { header: string; body: string } {
  const firstBreak = text.indexOf("\n");
  if (text.startsWith("✉")) {
    const header = firstBreak > 0 ? text.slice(0, firstBreak) : text;
    return { header, body: firstBreak > 0 ? text.slice(firstBreak + 1).trim() : "" };
  }
  const headerEnd = text.indexOf("]");
  if (text.startsWith("[") && headerEnd > 0) {
    return { header: text.slice(1, headerEnd), body: text.slice(headerEnd + 1).trim() };
  }
  return { header: "Note", body: text };
}

function cleanHeader(header: string, nameOf: (id: string) => string | undefined): string {
  const named = (text: string): string =>
    text.replace(UUID, (id) => nameOf(id) ?? "another bot").trim();
  const sent = /^✉\s*→\s*(\S+)\s*\((\w+)(?:\s*•\s*(.*))?\)\s*$/.exec(header);
  if (sent !== null) {
    const [, to = "", kind = "", topic] = sent;
    const parts = [
      `Message to ${named(to)}`,
      kind === "request" ? "asks for a reply" : null,
      topic,
    ];
    return parts.filter((part) => part !== null && part !== undefined && part !== "").join(" · ");
  }
  let asks = false;
  const parts = header
    .split(/\s+•\s+/)
    .filter((part) => {
      if (part === "request") asks = true;
      return part !== "notify" && part !== "request" && !part.startsWith("re: ");
    })
    .map(named)
    .filter((part) => part !== "");
  if (asks) parts.splice(1, 0, "asks for a reply");
  return capitalize(parts.join(" · "));
}

export function readNote(text: string, nameOf: (id: string) => string | undefined): Note {
  const { header, body } = splitNote(text);
  const cleaned = body.replace(BOT_FOOTER, "").trim();
  return { header: cleanHeader(header, nameOf), body: cleaned === "" ? header : cleaned };
}
