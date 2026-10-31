/**
 * The Generate faculty: one-shot, app-facing completion — session titles,
 * summaries, classifications, structured extraction — WITHOUT a conversation.
 * The owner rule stands: app code never touches a provider; it asks the mind,
 * and the mind's only non-conversational generation path is this faculty.
 *
 * Structured output is PROMPT-ONLY: some gateways (kenari among them) hang
 * on `response_format: json_object`, so the schema is rendered into the
 * prompt and the reply is extracted and validated here, with one repair
 * retry. That works the same on every provider.
 */
import { Context, Effect, Layer } from "effect";
import { ConfigError } from "effect/Config";
import type {
  Api,
  AssistantMessage,
  Context as PiContext,
  Message,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import { External, InvalidInput, Unavailable } from "@spreissen/core";
import { Value } from "typebox/value";
import type { Static, TSchema } from "typebox";
import { MindModels, ModelCatalog } from "../providers/models.ts";
import { parseRef } from "../providers/refs.ts";

/** The seam to one model completion; tests substitute it. */
export interface CompletionGateway {
  readonly complete: (
    model: Model<Api>,
    context: PiContext,
    maxTokens: number,
  ) => Promise<AssistantMessage>;
}

export type GenerateError = Unavailable | External | InvalidInput;

export interface GenerateRequest {
  readonly system?: string;
  readonly prompt: string;
  /** When set, the reply must be JSON matching this TypeBox schema. */
  readonly schema?: TSchema;
  /** `provider/model`; default is the mind's own. */
  readonly model?: string;
  readonly maxTokens?: number;
}

export interface GenerateService {
  readonly complete: (request: GenerateRequest) => Effect.Effect<string, GenerateError>;
  /** `complete` plus schema validation, returning the parsed value. */
  readonly extract: <S extends TSchema>(
    request: Omit<GenerateRequest, "schema"> & { readonly schema: S },
  ) => Effect.Effect<Static<S>, GenerateError>;
}

export class Generate extends Context.Service<Generate, GenerateService>()(
  "spreissen/mind/Generate",
) {}

const textOf = (message: AssistantMessage): string =>
  message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

const parseOf = (text: string): unknown => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  const json = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
};

const schemaInstruction = (schema: TSchema): string =>
  `\n\nReply with ONLY a JSON value matching this JSON schema — no prose, no code fence:\n${JSON.stringify(schema)}`;

export const generateService = (
  models: Models,
  defaultModelId: string,
  gateway: CompletionGateway,
  defaultMaxTokens = 1_024,
): GenerateService => {
  const ask = (
    model: Model<Api>,
    request: GenerateRequest,
    repair: string | null,
  ): Effect.Effect<string, GenerateError> => {
    const message: Message = {
      role: "user",
      content:
        request.prompt +
        (request.schema !== undefined ? schemaInstruction(request.schema) : "") +
        (repair !== null
          ? `\n\nYour previous reply was not valid (${repair}). Reply again, corrected.`
          : ""),
      timestamp: Date.now(),
    };
    return Effect.tryPromise({
      // A caller-supplied system prompt rides the context's leading system
      // message; per-request maxTokens override the faculty default.
      try: () =>
        gateway.complete(
          model,
          {
            ...(request.system !== undefined ? { systemPrompt: request.system } : {}),
            messages: [message],
          },
          request.maxTokens ?? defaultMaxTokens,
        ),
      catch: (cause) => new External({ op: "generate", cause }),
    }).pipe(Effect.map(textOf));
  };

  const complete = (request: GenerateRequest): Effect.Effect<string, GenerateError> =>
    Effect.gen(function* () {
      const ref = parseRef(request.model ?? defaultModelId);
      const model = models.getModel(ref.provider, ref.modelId);
      if (model === undefined) {
        return yield* new Unavailable({
          faculty: "generate",
          why: `no model ${ref.provider}/${ref.modelId} (is its provider key set?)`,
        });
      }
      const first = yield* ask(model, request, null);
      if (request.schema === undefined) return first;
      if (parseOf(first) !== undefined && Value.Check(request.schema, parseOf(first))) return first;
      return yield* ask(model, request, parseOf(first) === undefined ? "not JSON" : "off-schema");
    });

  return {
    complete,
    extract: (request) =>
      Effect.flatMap(complete(request), (text) => {
        const parsed = parseOf(text);
        if (!Value.Check(request.schema, parsed)) {
          return Effect.fail(
            new InvalidInput({ reason: "generate: reply did not match the schema" }),
          );
        }
        return Effect.succeed(parsed as Static<typeof request.schema>);
      }),
  };
};

/** The real gateway: pi-ai `Models.complete`, the one call this faculty makes. */
export const modelsGateway = (models: Models): CompletionGateway => ({
  complete: (model, context, maxTokens) => models.complete(model, context, { maxTokens }),
});

export interface GenerateOptions {
  /** Per-request token cap; the faculty's own default. */
  readonly maxTokens?: number;
}

export const generateLayer = (
  options: GenerateOptions = {},
): Layer.Layer<Generate, ConfigError, MindModels | ModelCatalog> =>
  Layer.effect(
    Generate,
    Effect.gen(function* () {
      const models = yield* MindModels;
      const catalog = yield* ModelCatalog;
      return generateService(
        models,
        catalog.defaultRef(),
        modelsGateway(models),
        options.maxTokens ?? 1_024,
      );
    }),
  );
