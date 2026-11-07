import { describe, expect, it } from "vite-plus/test";
import { sourceText } from "./file-source.tsx";

const chat = { sessionId: "s1", title: "Trip plans", main: false, botId: "b1" };

describe("sourceText", () => {
  it("names the chat, or the main chat by what it is", () => {
    expect(sourceText(chat)).toBe("From Trip plans");
    expect(sourceText({ ...chat, title: "Ada", main: true })).toBe("From the main chat");
  });

  it("names the task that wrote the file", () => {
    expect(sourceText({ ...chat, task: { id: "t1", title: "Flights" } })).toBe(
      'From task "Flights" in Trip plans',
    );
  });
});
