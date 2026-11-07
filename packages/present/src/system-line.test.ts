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

  it("a routine task with nothing to report reads as a quiet check-in", () => {
    expect(line("[task t1 finished]\n\n[nothing to report]")).toBe("Checked in: nothing to report");
  });

  it("a background shell job reads as finished, failed or lost, with its script", () => {
    expect(line("[job 1a2b finished] exit 0: make test\n\nall green")).toBe(
      "Background job finished: make test",
    );
    expect(line("[job 1a2b finished] exit 2: make test\n\nboom")).toBe(
      "Background job failed (exit 2): make test",
    );
    expect(line("[job 1a2b lost] npm run build\n\nThe server restarted")).toBe(
      "Background job lost in a restart: npm run build",
    );
  });

  it("an access change reads as one line", () => {
    expect(line("[access changed] Your owner changed what you may do: tools removed: bash.")).toBe(
      "Access changed: Your owner changed what you may do: tools removed: bash.",
    );
  });
});
