import { describe, expect, it } from "vite-plus/test";
import { isRedirect } from "@tanstack/react-router";
import { Route as BotsRoute } from "../routes/bots.tsx";
import { MOVED, badgeText, sectionOf } from "./nav.ts";

describe("sectionOf", () => {
  it("maps home and chat routes to Chat", () => {
    expect(sectionOf("/")).toBe("chat");
    expect(sectionOf("/c/abc")).toBe("chat");
    expect(sectionOf("/history")).toBe("chat");
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
  it("knows Needs you and nothing else", () => {
    expect(sectionOf("/needs")).toBe("needs");
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

describe("moved pages", () => {
  it("sends the old Bots page to Crew, replacing the history entry", () => {
    expect(MOVED["/bots"]).toBe("/crew");
    const beforeLoad = BotsRoute.options.beforeLoad as () => void;
    let thrown: unknown;
    try {
      beforeLoad();
    } catch (error) {
      thrown = error;
    }
    expect(isRedirect(thrown)).toBe(true);
    const options = (thrown as { options: { to: string; replace?: boolean } }).options;
    expect(options.to).toBe("/crew");
    expect(options.replace).toBe(true);
  });
});
