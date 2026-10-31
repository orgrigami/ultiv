/**
 * Connectors are the standardized seam to external services: identity, auth
 * (env-backed today, OAuth tomorrow), and TypeBox-typed actions whose
 * `perform`s are Effects. The schema language at this boundary is TypeBox, so
 * connector capabilities can cross the wire later without reshaping.
 */
import { Config, Effect, Option } from "effect";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { AuthMissing, External, InvalidInput, NotFound } from "@spreissen/core";

export type ActionError = AuthMissing | External | InvalidInput;

/** How a connector authenticates. `env` reads a key from the environment; `vault` redeems a sealed vault item. */
export type AuthSpec =
  | { readonly kind: "none" }
  | { readonly kind: "env"; readonly env: string; readonly displayName: string }
  | { readonly kind: "vault"; readonly item: string; readonly displayName: string };

/** Resolved credentials handed to an action's `perform`. */
export interface ConnectorContext {
  readonly apiKey?: string;
}

/** Vault-backed credential resolution: the act layer provides one per owner. */
export interface AuthSource {
  readonly resolveItem: (itemId: string) => { readonly apiKey?: string } | undefined;
}

export interface Action<Input extends TSchema = TSchema, Output extends TSchema = TSchema> {
  readonly name: string;
  readonly description: string;
  readonly input: Input;
  readonly output: Output;
  /** Method syntax on purpose: keeps `Action<I, O>` assignable to `Action` in registries. */
  perform(
    input: Static<Input>,
    context: ConnectorContext,
  ): Effect.Effect<Static<Output>, ActionError>;
}

export interface Connector {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly auth: AuthSpec;
  readonly actions: readonly Action[];
}

export const defineAction = <const Input extends TSchema, const Output extends TSchema>(
  action: Action<Input, Output>,
): Action<Input, Output> => action;

export const defineConnector = (connector: Connector): Connector => connector;

/** Resolve the connector's credentials; empty counts as absent. */
export const resolveAuth = (
  connector: Connector,
  source?: AuthSource,
): Effect.Effect<ConnectorContext, AuthMissing> =>
  Effect.gen(function* () {
    if (connector.auth.kind === "none") return {};
    if (connector.auth.kind === "vault") {
      // Vault-backed: redeem in-process. An absent source or item is a missing
      // credential — the secret itself never crosses a model-facing surface.
      const resolved = source?.resolveItem(connector.auth.item);
      if (resolved === undefined || resolved.apiKey === undefined || resolved.apiKey === "") {
        return yield* new AuthMissing({ connector: connector.id, env: connector.auth.item });
      }
      return { apiKey: resolved.apiKey };
    }
    // An unreadable provider counts as absent: the caller hears AuthMissing either way.
    const key = yield* Effect.match(Config.option(Config.String(connector.auth.env)), {
      onFailure: () => Option.none<string>(),
      onSuccess: (value) => value,
    });
    if (Option.isNone(key) || key.value.trim() === "") {
      return yield* new AuthMissing({ connector: connector.id, env: connector.auth.env });
    }
    return { apiKey: key.value };
  });

/** The boundary every connector call goes through: validate, authenticate, perform. */
export const invoke = (
  connector: Connector,
  actionName: string,
  input: unknown,
  source?: AuthSource,
): Effect.Effect<unknown, ActionError | NotFound> =>
  Effect.gen(function* () {
    const action = connector.actions.find((candidate) => candidate.name === actionName);
    if (action === undefined) {
      return yield* new NotFound({ what: `${connector.id}.${actionName}` });
    }
    if (!Value.Check(action.input, input)) {
      return yield* new InvalidInput({
        reason: `${connector.id}.${actionName}: input does not match the action schema`,
      });
    }
    const context = yield* resolveAuth(connector, source);
    return yield* action.perform(input as never, context);
  });
