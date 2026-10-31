/**
 * The reference connector plugin: generic HTTP egress. Proof that the
 * standard needs no special-casing — and the connector most future
 * integrations start from. No auth: whatever a target needs goes in headers.
 */
import { Effect } from "effect";
import { Type } from "typebox";
import { External } from "@spreissen/core";
import type { Connector } from "../connector.ts";
import { defineAction, defineConnector } from "../connector.ts";
import { connectorCapability, definePlugin } from "../plugin.ts";

const RequestInput = Type.Object({
  method: Type.Union(
    [Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT"), Type.Literal("DELETE")],
    { description: "HTTP method." },
  ),
  url: Type.String({ description: "Absolute URL to request." }),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), { description: "Request headers." }),
  ),
  body: Type.Optional(Type.String({ description: "Request body, sent as-is." })),
});

const RequestOutput = Type.Object({
  status: Type.Number(),
  body: Type.String(),
});

const request = defineAction({
  name: "request",
  description: "Perform one HTTP request; returns the status and the response body text.",
  input: RequestInput,
  output: RequestOutput,
  perform: (input) =>
    Effect.tryPromise({
      try: async () => {
        const init: RequestInit = { method: input.method };
        if (input.headers !== undefined) init.headers = input.headers;
        if (input.body !== undefined) init.body = input.body;
        const response = await fetch(input.url, init);
        return { status: response.status, body: await response.text() };
      },
      catch: (cause) => new External({ op: `http ${input.method} ${input.url}`, cause }),
    }),
});

/** Generic HTTP egress: the `request` action on connector `http`. */
export const httpConnector: Connector = defineConnector({
  id: "http",
  name: "HTTP",
  description: "Generic HTTP egress to any reachable URL.",
  auth: { kind: "none" },
  actions: [request],
});

export const httpPlugin = definePlugin({
  id: "ultiv.http",
  version: "1.0.0",
  description:
    "Generic HTTP egress connector (reference implementation of the connector standard).",
  capabilities: [connectorCapability(httpConnector)],
});

/** The request action with vault-backed bearer auth. */
const bearerRequest = defineAction({
  name: "request",
  description:
    "Perform one HTTP request with the vault's bearer token; returns the status and body text.",
  input: RequestInput,
  output: RequestOutput,
  perform: (input, context) =>
    Effect.tryPromise({
      try: async () => {
        const headers = { ...input.headers };
        if (headers.authorization === undefined && context.apiKey !== undefined) {
          headers.authorization = `Bearer ${context.apiKey}`;
        }
        const init: RequestInit = { method: input.method, headers };
        if (input.body !== undefined) init.body = input.body;
        const response = await fetch(input.url, init);
        return { status: response.status, body: await response.text() };
      },
      catch: (cause) => new External({ op: `http ${input.method} ${input.url}`, cause }),
    }),
});

/** HTTP egress with the credential redeemed from the vault — never model-visible. */
export const vaultedHttpConnector: Connector = defineConnector({
  id: "http-bearer",
  name: "HTTP (vault bearer)",
  description: "HTTP egress authenticated by a sealed vault item (kind `key`).",
  auth: { kind: "vault", item: "http-bearer", displayName: "HTTP Bearer (vault item)" },
  actions: [bearerRequest],
});
