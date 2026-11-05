import { hostNamed, method, remote } from "@earendil-works/chord";
import { Type } from "typebox";
import { wire } from "./chord-schema.ts";

export const Ping = remote("ultiv.ping", {
  version: 1,
  input: wire(Type.Object({ name: Type.String() })),
  host: hostNamed("server"),
  variants: {
    default: {
      state: { count: wire(Type.Number()) },
      methods: { increment: method(wire(Type.Object({ by: Type.Number() }))) },
    },
  },
});
