import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChecklistStrip } from "./checklist-strip.tsx";

const LIST = {
  listId: "p1",
  title: "Release",
  items: [
    { text: "Write the notes", status: "done" as const },
    { text: "Tag the build", status: "done" as const },
    { text: "Upload it", status: "in_progress" as const },
    { text: "Tell the team", status: "pending" as const },
  ],
};

describe("ChecklistStrip", () => {
  it("reads Tasks 2/4 and the step in progress, folded", () => {
    const html = renderToStaticMarkup(<ChecklistStrip list={LIST} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Tasks, 2 of 4 done. Show the steps");
    expect(html).toContain(">2/4<");
    expect(html).toContain("· Upload it");
    expect(html).not.toContain("<ol");
  });
  it("renders nothing without a plan", () => {
    expect(renderToStaticMarkup(<ChecklistStrip list={null} />)).toBe("");
  });
  it("hides a plan that was already finished when the chat opened", () => {
    const done = {
      ...LIST,
      items: LIST.items.map((item) => ({ ...item, status: "done" as const })),
    };
    expect(renderToStaticMarkup(<ChecklistStrip list={done} />)).toBe("");
  });
});
