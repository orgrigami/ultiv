/**
 * The chord boundary's one adapter. Chord 1.5 checks contracts with
 * `@earendil-works/pi-schema`, which takes any JSON Schema object; a TypeBox
 * schema IS one, so it validates as is. Only its type needs help: TypeBox's
 * schema types are interfaces without an index signature, so they do not
 * assign to pi-schema's `Schema`. `wire` keeps TypeBox's static type on the
 * schema chord sees (no copy, nothing changes at run time), so contracts stay
 * TypeBox and handlers keep their typed arguments and state.
 */
import type { Schema } from "@earendil-works/pi-schema";
import type { Static, TSchema } from "typebox";

export const wire = <T extends TSchema>(schema: T): Schema<Static<T>> =>
  schema as unknown as Schema<Static<T>>;
