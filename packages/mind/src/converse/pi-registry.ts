/**
 * The pi-durable registry the harness runs on, as a service so composition
 * can build the harness before every contributor is resolved. pi-durable
 * registries may keep changing while the harness runs, so the mind installs
 * the act's extension, codemode, and the task tools into it once ALL services
 * are up — no layer cycle between tasks (which needs converse) and the
 * converse layer that opens the harness.
 */
import { Context, Effect, Layer } from "effect";
import { createRegistry, type Registry } from "@earendil-works/pi-durable";

export class PiRegistry extends Context.Service<PiRegistry, Registry>()(
  "spreissen/mind/PiRegistry",
) {}

export const piRegistryLayer: Layer.Layer<PiRegistry> = Layer.effect(
  PiRegistry,
  Effect.sync(() => createRegistry()),
);
