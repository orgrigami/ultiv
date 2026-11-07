import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoutineTrial } from "@spriessen/contracts";
import { TrialResult, trialActionText } from "./routine-trial.tsx";

const trial = (over: Partial<RoutineTrial> = {}): RoutineTrial => ({
  at: Date.UTC(2026, 10, 7, 9, 0),
  reply: "Sent the weekly numbers to the team.",
  actions: [
    { name: "web_search", input: { query: "weekly sales" } },
    { name: "now", input: {} },
  ],
  error: null,
  ...over,
});

describe("TrialResult", () => {
  it("says what the routine would have done, in the chat's words, and that nothing ran", () => {
    const html = renderToStaticMarkup(<TrialResult trial={trial()} />);
    expect(html).toContain("Nothing ran or was sent.");
    expect(html).toContain("Would have:");
    expect(html).toContain(
      trialActionText({ name: "web_search", input: { query: "q" } }, 0)!.split(" · ")[0],
    );
    expect(html).toContain("Would have said: </span>Sent the weekly numbers to the team.");
  });

  it("leaves inner monologue tools out", () => {
    expect(trialActionText({ name: "now", input: {} }, 0)).toBeNull();
  });

  it("a quiet trial reads as nothing to report; a failed one says why", () => {
    expect(
      renderToStaticMarkup(
        <TrialResult trial={trial({ reply: "[nothing to report]", actions: [] })} />,
      ),
    ).toContain("nothing to report");
    const failed = renderToStaticMarkup(
      <TrialResult trial={trial({ error: "No model is set up." })} />,
    );
    expect(failed).toContain("Couldn&#x27;t run the trial: No model is set up.");
  });
});
