import { hostNamed, method, remote } from "@earendil-works/chord";
import { num, obj, str } from "@earendil-works/pi-schema";

export const Ping = remote("ultiv.ping", {
  version: 1,
  input: obj({ name: str() }, { open: true }),
  host: hostNamed("server"),
  variants: {
    default: {
      state: { count: num() },
      methods: { increment: method(obj({ by: num() }, { open: true })) },
    },
  },
});
