/**
 * Human outbound: the entity can dispatch email on the owner's behalf through
 * Resend (`RESEND_API_KEY`, sender identity `EMAIL_FROM`). The plugin installs
 * only when both are present. Sending is a GATED act — every dispatch waits
 * for the user's approval.
 */
import { Type } from "typebox";
import { definePlugin, toolCapability, type Plugin } from "../plugin.ts";
import { defineTool, type Tool } from "../tool.ts";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export const emailConfigured = (): boolean =>
  process.env.RESEND_API_KEY?.trim() !== "" &&
  process.env.EMAIL_FROM?.trim() !== "" &&
  process.env.RESEND_API_KEY !== undefined &&
  process.env.EMAIL_FROM !== undefined;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const Params = Type.Object({
  to: Type.Array(Type.String(), {
    description: "Recipient addresses (one or more).",
    minItems: 1,
    maxItems: 20,
  }),
  subject: Type.String({ description: "The subject line." }),
  text: Type.String({ description: "The plain-text body." }),
});

type PostJson = (
  url: string,
  key: string,
  body: unknown,
) => Promise<{ ok: boolean; status: number; id?: string }>;

const sendEmail = async (
  post: PostJson,
  from: string,
  args: { readonly to: readonly string[]; readonly subject: string; readonly text: string },
): Promise<{ ok: true; id: string | null } | { ok: false; error: string }> => {
  for (const address of args.to) {
    if (!EMAIL.test(address)) return { ok: false, error: `invalid address: ${address}` };
  }
  try {
    const response = await post(RESEND_ENDPOINT, process.env.RESEND_API_KEY ?? "", {
      from,
      to: [...args.to],
      subject: args.subject,
      text: args.text,
    });
    if (!response.ok) return { ok: false, error: `provider returned ${response.status}` };
    return { ok: true, id: response.id ?? null };
  } catch (cause) {
    return { ok: false, error: String(cause) };
  }
};

const sendTool = (post: PostJson, from: string): Tool =>
  defineTool({
    name: "email_send",
    gated: true,
    description:
      "Send an email to a person: real outbound to the world; it can't be unsent. Your owner " +
      "approves every send: first state the recipient, subject and gist in a sentence. Draft " +
      "the body in the conversation first; dispatch only on a clear instruction. Include only " +
      "the personal data the email needs.",
    parameters: Params,
    structuredOutputSchema: Type.Object({
      sent: Type.Boolean(),
      id: Type.Union([Type.String(), Type.Null()]),
    }),
    execute: async (args) => {
      const outcome = await sendEmail(post, from, args);
      if (!outcome.ok) {
        return {
          output: [{ type: "text" as const, text: `send failed: ${outcome.error}` }],
          isError: true as const,
        };
      }
      return {
        output: [
          {
            type: "text" as const,
            text: `sent to ${args.to.join(", ")}${outcome.id === null ? "" : ` (id ${outcome.id})`}`,
          },
        ],
        structuredOutput: { sent: true, id: outcome.id },
      };
    },
  });

const resendPost: PostJson = async (url, key, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const parsed = (await response.json().catch(() => ({}))) as { id?: string };
  return {
    ok: response.ok,
    status: response.status,
    ...(parsed.id !== undefined ? { id: parsed.id } : {}),
  };
};

/** The email plugin: on only when RESEND_API_KEY and EMAIL_FROM are set. */
export const emailPlugin = (options: { readonly post?: PostJson } = {}): Plugin =>
  definePlugin({
    id: "ultiv.email",
    version: "1.0.0",
    description: "Gated human outbound email through Resend (RESEND_API_KEY + EMAIL_FROM).",
    capabilities: [
      toolCapability(sendTool(options.post ?? resendPost, process.env.EMAIL_FROM ?? "")),
    ],
  });
