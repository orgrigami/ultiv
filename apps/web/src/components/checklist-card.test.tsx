import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChecklistCard } from "./checklist-card.tsx";

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

describe("ChecklistCard", () => {
  const html = renderToStaticMarkup(<ChecklistCard list={LIST} />);

  it("counts done steps as Tasks 2/4 with a bar at half", () => {
    expect(html).toContain('aria-label="Tasks, 2 of 4 done"');
    expect(html).toMatch(/>Tasks<\/span><span[^>]*>2\/4<\/span>/);
    expect(html).toContain("width:50%");
  });

  it("strikes done steps, marks the one in progress, says each state", () => {
    expect(html.match(/line-through/g)?.length).toBe(2);
    expect(html.match(/font-medium/g)?.length).toBe(2);
    expect(html).toContain('Upload it<span class="sr-only"> (in progress)</span>');
    expect(html).toContain('Tell the team<span class="sr-only"> (to do)</span>');
  });
});
