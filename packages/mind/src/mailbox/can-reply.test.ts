import { describe, expect, it } from "vite-plus/test";
import { canReply } from "./delivery.ts";

/** A conversation stub whose resolved agent offers `names`. */
const chatWith = (names: readonly string[] | Error) => ({
  agent: async () => {
    if (names instanceof Error) throw names;
    return { tools: names.map((name) => ({ name })), callable: [] };
  },
});

describe("a request to a bot that cannot reply is refused, not a silent turn", () => {
  it("a bot without the message tool cannot reply", async () => {
    expect(await canReply(chatWith(["bash", "bots_list"]))).toBe(false);
  });

  it("a bot with message can; an unreadable agent is given the benefit of the doubt", async () => {
    expect(await canReply(chatWith(["bash", "message"]))).toBe(true);
    expect(await canReply(chatWith(new Error("closed")))).toBe(true);
  });
});
