/**
 * Owner-facing words for a gated tool call: what the bot wants to do, how
 * risky it is and why, and the most telling bit of its input.
 */

/** Tools that reach outside the conversation (delete/send/pay/publish). */
const RISKY_TOOL =
  /delete|remove|purge|drop|send|post|email|tweet|publish|pay|transfer|archive|overwrite|bash|shell|exec/i;

/** Input fields worth quoting in the summary, most telling first. */
const HINT_KEYS = [
  "to",
  "url",
  "subject",
  "title",
  "path",
  "name",
  "query",
  "command",
  "script",
  "text",
];

interface Known {
  action: string;
  risk: string;
  /** Overrides the name-based guess. */
  risky?: boolean;
}

/** The gated tools the server ships, in plain words. */
const KNOWN: Record<string, Known> = {
  bash: {
    action: "run a script in its workspace",
    risk: "Higher risk: the script can change files and reach the network.",
  },
  email_send: {
    action: "send an email",
    risk: "Higher risk: the email leaves this app and can't be unsent.",
  },
  artifact_delete: { action: "delete a file", risk: "Higher risk: the file is removed for good." },
  webhook_create: {
    action: "create a webhook",
    risk: "Opens a URL that can start this bot. You can remove it under Routines.",
  },
  webhook_remove: {
    action: "remove a webhook",
    risk: "Higher risk: anything calling that URL will be turned away.",
  },
  schedule_set: {
    action: "set up a schedule",
    risk: "Lower risk: you can pause or remove it under Routines.",
  },
  schedule_remove: {
    action: "remove a schedule",
    risk: "Higher risk: the schedule stops for good.",
  },
  sensor_set: {
    action: "set up a watch",
    risk: "Lower risk: you can pause or remove it under Routines.",
  },
  sensor_remove: { action: "remove a watch", risk: "Higher risk: the watch stops for good." },
  http_request: {
    action: "send a web request that can change something",
    risk: "Higher risk: a POST/PUT/PATCH/DELETE can create, change or delete data on that site.",
    risky: true,
  },
  "http_request (first use of a credential)": {
    action: "use a saved credential on a site for the first time",
    risk: "Approving lets it use that credential on this host from now on. The bot never sees the secret.",
    risky: true,
  },
  connector_add: {
    action: "add a connector",
    risk: "Its tools become available to the bots listed below. Check the address first.",
    risky: true,
  },
  connector_update: {
    action: "change a connector",
    risk: "Only the changes listed below are made.",
    risky: true,
  },
  connector_disable: {
    action: "switch a connector off",
    risk: "Lower risk: it is kept and can be switched back on.",
    risky: false,
  },
  connector_enable: {
    action: "switch a connector back on",
    risk: "Its tools become available again to the bots listed below.",
    risky: true,
  },
  connector_remove: {
    action: "remove a connector",
    risk: "Higher risk: every bot loses it, and its sign-in is forgotten.",
    risky: true,
  },
  secret_request: {
    action: "get a key from you",
    risk: "What you type goes straight to your vault. The bot never sees it.",
    risky: false,
  },
  bot_create: {
    action: "create a new bot",
    risk: "Lower risk: it joins your bots with the details on the form; edit or archive it any time.",
  },
};

/** "schedule_set" -> "schedule set"; camelCase too. */
const humanize = (tool: string): string =>
  tool
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .trim()
    .toLowerCase();

export interface ApprovalText {
  /** Completes "Eve wants to …". */
  action: string;
  risky: boolean;
  risk: string;
}

export function describeTool(name: string): ApprovalText {
  const risky = RISKY_TOOL.test(name);
  const known = KNOWN[name];
  if (known !== undefined)
    return { action: known.action, risky: known.risky ?? risky, risk: known.risk };
  return {
    action: `use ${humanize(name)}`,
    risky,
    risk: risky
      ? "Higher risk: this may reach outside the chat and may not be undoable."
      : "Lower risk: it doesn't send or delete anything.",
  };
}

const flatten = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    return value.join(", ");
  }
  return null;
};

/** The first telling input value, on one line and at most 60 characters. */
export function hintOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const key of HINT_KEYS) {
    const value = flatten(record[key]);
    if (value !== null && value.trim() !== "") {
      const flat = value.replace(/\s+/g, " ").trim();
      return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
    }
  }
  return null;
}

/** Connector changes: always shown on their own card, never pre-approved. */
export const isConnectorChange = (name: string): boolean =>
  /^connector_(add|update|disable|enable|remove)$/.test(name);

/**
 * Cards "Always allow" may not cover: a credential's or connector's first
 * use, connector changes and secure inputs are asked every time.
 */
export const canAlwaysAllow = (name: string): boolean =>
  name !== "http_request (first use of a credential)" &&
  !name.startsWith("mcp (first use of ") &&
  !isConnectorChange(name) &&
  name !== "secret_request";
