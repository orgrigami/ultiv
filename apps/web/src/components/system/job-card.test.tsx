import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseSystem } from "@/lib/system-text";
import { JobCard } from "./job-card.tsx";

const card = (text: string) => {
  const message = parseSystem(text);
  if (message?.kind !== "job") throw new Error("not a job");
  return renderToStaticMarkup(<JobCard message={message} at={0} />);
};

describe("JobCard", () => {
  it("says how the job ended and which script it was, output folded", () => {
    const done = card("[job 1a2b finished] exit 0: make test\n\nall green");
    expect(done).toContain("Background job finished");
    expect(done).toContain("make test");
    expect(done).toContain("Show output");
    expect(done).not.toContain("all green");
    expect(card("[job 1a2b finished] exit 1: make test\n\nboom")).toContain("failed (exit 1)");
    expect(card("[job 1a2b lost] make\n\nThe server restarted")).toContain("lost in a restart");
  });
});
