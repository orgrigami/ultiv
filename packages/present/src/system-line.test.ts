import { describe, expect, it } from "vite-plus/test";
import { systemLine } from "./system-line.ts";
import { parseSystem } from "./system-text.ts";

const line = (text: string) => {
  const message = parseSystem(text);
  return message === null ? undefined : systemLine(message);
};

describe("systemLine", () => {
  it("says what each kind of machinery message is, in one line", () => {
    expect(line("[task t1 finished]\n\n## Prices\nAll good")).toBe("Task finished: Prices");
    expect(line("[task t1 failed] the site was down")).toBe("Task failed: the site was down");
    expect(line("[cron j1] water the plants")).toBe("Routine ran: water the plants");
    expect(line("[resume] carry on")).toBeNull();
    expect(line("just words")).toBeUndefined();
  });
});
