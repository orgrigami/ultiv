/**
 * The polls stay gone: the four screens that used to poll on timers
 * (app-state's approvals and tasks, the chat task pill, the task sheet and
 * the connectors panel) may not grow a data-polling `setInterval` again.
 * They refresh on pushed signals now; the only allowed timers live elsewhere
 * (the push presence heartbeat and the UI clock).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const here = dirname(fileURLToPath(import.meta.url));

const FORMER_POLL_SITES = [
  join(here, "../lib/app-state.tsx"),
  join(here, "../lib/use-tasks.ts"),
  join(here, "../components/task-sheet/use-task-activity.ts"),
  join(here, "../components/connectors/connectors-panel.tsx"),
];

describe("no data polling", () => {
  it("the former poll sites subscribe to live signals instead", () => {
    for (const file of FORMER_POLL_SITES) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toContain("onLive(");
      expect(source, file).not.toContain("setInterval");
    }
  });
});
