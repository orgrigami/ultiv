import { Effect } from "effect";
import { External } from "@spreissen/core";

/** A harness promise as an Effect failing with `External { op }`. */
export const asEffect = <A>(op: string, promise: Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({ try: () => promise, catch: (cause) => new External({ op, cause }) });
