/**
 * The shared kernel error vocabulary. Every package tags its failures from
 * this taxonomy so `Effect.catchTag` composes across package boundaries
 * without translation layers. Domain-specific errors live in their package.
 */
import { Data } from "effect";

/** A lookup found nothing registered (or stored) under that identity. */
export class NotFound extends Data.TaggedError("spreissen/NotFound")<{
  readonly what: string;
}> {}

/** A value failed validation before it reached any boundary. */
export class InvalidInput extends Data.TaggedError("spreissen/InvalidInput")<{
  readonly reason: string;
}> {}

/** The same identity was registered twice (plugin id, tool name, connector id). */
export class Duplicate extends Data.TaggedError("spreissen/Duplicate")<{
  readonly kind: string;
  readonly id: string;
}> {}

/** A capability is not wired (typically: its key is not configured). */
export class Unavailable extends Data.TaggedError("spreissen/Unavailable")<{
  readonly faculty: string;
  readonly why: string;
}> {}

/** An external integration is required but its credentials are absent. */
export class AuthMissing extends Data.TaggedError("spreissen/AuthMissing")<{
  readonly connector: string;
  readonly env: string;
}> {}

/** An external call failed; `cause` carries the original error. */
export class External extends Data.TaggedError("spreissen/External")<{
  readonly op: string;
  readonly cause: unknown;
}> {}
