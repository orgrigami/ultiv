import { describe, expect, it } from "vite-plus/test";
import type { ProfileInfo, SessionInfo } from "@spreissen/contracts";
import { chatTitle, pastChats } from "./chats.ts";

const bot = (id: string, name: string) => ({ id, name }) as unknown as ProfileInfo;
const session = (
  id: string,
  profile: string,
  kind: SessionInfo["kind"],
  title: string,
  at: number,
): SessionInfo => ({
  id,
  owner: "guest",
  profile,
  kind,
  participants: null,
  title,
  createdAt: at,
  lastMessageAt: at,
});

const profiles = [bot("b1", "Atlas"), bot("b2", "Nova")];
const sessions = [
  session("s1", "b1", "main", "", 10),
  session("s2", "b2", "session", "Trip notes", 30),
  session("s3", "b1", "dm", "", 40),
  session("s4", "b1", "session", "", 20),
  session("s5", "gone", "session", "Orphan", 50),
];

describe("pastChats", () => {
  it("lists main and started chats newest first, without bot plumbing", () => {
    const rows = pastChats({ sessions, profiles });
    expect(rows.map((row) => row.id)).toEqual(["s2", "s4", "s1"]);
    expect(rows[2]).toMatchObject({ main: true, botName: "Atlas", title: "Atlas · main chat" });
    expect(rows[1]?.title).toBe("Untitled chat");
  });
  it("filters by title or bot name, case-insensitively", () => {
    expect(pastChats({ sessions, profiles, query: "trip" }).map((row) => row.id)).toEqual(["s2"]);
    expect(pastChats({ sessions, profiles, query: "ATLAS" }).map((row) => row.id)).toEqual([
      "s4",
      "s1",
    ]);
  });
  it("caps the list for Recents", () => {
    expect(pastChats({ sessions, profiles, limit: 1 })).toHaveLength(1);
  });
  it("names chats plainly", () => {
    expect(chatTitle({ kind: "session", title: "  " }, "Nova")).toBe("Untitled chat");
  });
});
