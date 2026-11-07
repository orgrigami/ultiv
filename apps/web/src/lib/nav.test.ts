import { describe, expect, it } from "vite-plus/test";
import { isRedirect } from "@tanstack/react-router";
import { Route as BotsRoute } from "../routes/bots.tsx";
import { Route as NeedsRoute } from "../routes/needs.tsx";
import { MOVED, SECTIONS, SECTION_LABEL, badgeText, sectionOf } from "./nav.ts";

describe("sectionOf", () => {
  it("is four places: Now, Chats, Crew, Settings", () => {
    expect(SECTIONS).toEqual(["now", "chats", "crew", "settings"]);
    expect(SECTIONS.map((section) => SECTION_LABEL[section])).toEqual([
      "Now",
      "Chats",
      "Crew",
      "Settings",
    ]);
  });
  it("keeps the chat, every chat and Past chats under Chats", () => {
    expect(sectionOf("/")).toBe("chats");
    expect(sectionOf("/c/abc")).toBe("chats");
    expect(sectionOf("/history")).toBe("chats");
  });
  it("keeps the old bot and routine pages under Crew", () => {
    expect(sectionOf("/crew")).toBe("crew");
    expect(sectionOf("/crew/bot-1")).toBe("crew");
    expect(sectionOf("/bots")).toBe("crew");
    expect(sectionOf("/routines")).toBe("crew");
    expect(sectionOf("/rooms")).toBe("crew");
  });
  it("puts tools and vault under Settings", () => {
    expect(sectionOf("/settings")).toBe("settings");
    expect(sectionOf("/tools")).toBe("settings");
    expect(sectionOf("/vault")).toBe("settings");
  });
  it("folds Needs you into Now, and knows nothing else", () => {
    expect(sectionOf("/now")).toBe("now");
    expect(sectionOf("/needs")).toBe("now");
    expect(sectionOf("/nowhere")).toBeNull();
  });
});

describe("badgeText", () => {
  it("hides zero and caps at 9+", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(3)).toBe("3");
    expect(badgeText(12)).toBe("9+");
  });
});

const redirectOf = (beforeLoad: unknown): { to: string; replace?: boolean } => {
  let thrown: unknown;
  try {
    (beforeLoad as () => void)();
  } catch (error) {
    thrown = error;
  }
  expect(isRedirect(thrown)).toBe(true);
  return (thrown as { options: { to: string; replace?: boolean } }).options;
};

describe("moved pages", () => {
  it("sends the old Bots page to Crew, replacing the history entry", () => {
    expect(MOVED["/bots"]).toBe("/crew");
    expect(redirectOf(BotsRoute.options.beforeLoad)).toMatchObject({ to: "/crew", replace: true });
  });
  it("sends Needs you (old pushes and bookmarks) to Now", () => {
    expect(MOVED["/needs"]).toBe("/now");
    expect(redirectOf(NeedsRoute.options.beforeLoad)).toMatchObject({ to: "/now", replace: true });
  });
});
