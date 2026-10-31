/**
 * `secret_request`: ask the owner for a key in a secure field. The value goes
 * from their browser to the vault; this tool only learns the item name and
 * id. With `bindTo` it also lets `http_request` send it to one host.
 */
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { defineTool, type BindingStore } from "@spreissen/ext";
import { withAudit } from "../audit/audit.ts";
import type { AuditService } from "../audit/audit.ts";
import { textReply } from "../act/task-live.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { SECRET_REQUEST, type SecretRequestsService } from "./requests.ts";

export interface SecretToolDeps {
  readonly secrets: SecretRequestsService;
  readonly bindings: BindingStore | null;
  readonly profiles: ProfilesService;
  readonly audit: AuditService;
}

const Field = Type.Object({
  key: Type.String({ pattern: "^[a-z0-9_]{1,40}$" }),
  label: Type.String({ minLength: 1, maxLength: 60 }),
});

const BindTo = Type.Object({
  host: Type.String({
    description: "The only host http_request may send it to, e.g. api.example.com.",
  }),
  header: Type.Optional(Type.String({ description: "Header name (default Authorization)." })),
  prefix: Type.Optional(
    Type.String({ description: 'Prefix (default "Bearer " for Authorization).' }),
  ),
});

const bind = (
  deps: SecretToolDeps,
  scope: { owner: string; profileId: string },
  itemId: string,
  target: { host: string; header?: string | undefined; prefix?: string | undefined },
): string => {
  if (deps.bindings === null) return "";
  const name = target.header ?? "Authorization";
  const prefix = target.prefix ?? (name.toLowerCase() === "authorization" ? "Bearer " : "");
  deps.bindings.put(scope.owner, itemId, {
    adapter: "http",
    hosts: [target.host.trim().toLowerCase()],
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    auth: { placement: "header", name, ...(prefix !== "" ? { prefix } : {}) },
    profiles: [scope.profileId],
    allowLocalhostHttp: false,
  });
  return ` http_request can now send it to ${target.host} in the ${name} header (pass it as the credential).`;
};

const secretTool = (deps: SecretToolDeps) =>
  defineTool({
    name: SECRET_REQUEST,
    description:
      "Ask your owner to type a key or token into a secure field in the chat. It goes straight " +
      "to the vault; you only get the vault item's name. Never ask for keys in chat. Give " +
      "`bindTo` when http_request should use it.",
    parameters: Type.Object({
      label: Type.String({ minLength: 1, maxLength: 60, description: 'e.g. "API key for Acme"' }),
      purpose: Type.String({
        minLength: 1,
        maxLength: 200,
        description: "Why it is needed, in plain words.",
      }),
      fields: Type.Optional(Type.Array(Field, { minItems: 1, maxItems: 5 })),
      bindTo: Type.Optional(BindTo),
    }),
    execute: async (args, api) => {
      const conversationId = String(api.conversationId);
      const scope = deps.profiles.scopeOf(conversationId);
      if (scope === undefined) return textReply("this conversation belongs to no bot", true);
      const fields = args.fields ?? [{ key: "secret", label: args.label }];
      if (args.bindTo !== undefined && fields.length !== 1)
        return textReply("bindTo needs exactly one field", true);
      if (args.bindTo !== undefined && deps.bindings === null)
        return textReply("the vault is not set up", true);
      const outcome = await deps.secrets.ask(conversationId, api.callId, {
        label: args.label,
        purpose: args.purpose,
        fields,
        ...(args.bindTo !== undefined ? { usedFor: `only sent to ${args.bindTo.host}` } : {}),
      });
      if (!outcome.ok) return textReply(outcome.reason, true);
      const lines = outcome.stored.map(
        (item) => `${item.key}: stored as vault item "${item.name}" (id ${item.itemId})`,
      );
      let bound = "";
      if (args.bindTo !== undefined && outcome.stored[0] !== undefined) {
        try {
          bound = bind(deps, scope, outcome.stored[0].itemId, args.bindTo);
        } catch (cause) {
          bound = ` Could not bind it: ${String((cause as { reason?: unknown }).reason ?? "invalid host")}.`;
        }
      }
      return textReply(`Saved.${bound}\n${lines.join("\n")}`);
    },
  });

export const secretTools = (deps: SecretToolDeps): ToolRegistration[] => {
  const profileOf = (conversationId: string) => deps.profiles.profileOf(conversationId)?.id ?? null;
  return [withAudit(deps.audit, secretTool(deps) as unknown as ToolRegistration, profileOf)];
};
