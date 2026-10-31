import { describe, expect, it } from "vite-plus/test";
import { answerInput, questionOf, questionTitle } from "./question.ts";

describe("question card data", () => {
  it("reads the question and options, skipping broken ones", () => {
    expect(
      questionOf({
        question: " Which one? ",
        options: [{ label: "A" }, { label: "" }, "x", { label: "B", detail: "the other" }],
        allowOther: false,
      }),
    ).toEqual({
      question: "Which one?",
      options: [{ label: "A" }, { label: "B", detail: "the other" }],
      allowOther: false,
    });
    expect(questionOf({ question: "Q", options: [{ label: "A" }] })?.allowOther).toBe(true);
    expect(questionOf({ question: "", options: [{ label: "A" }] })).toBeNull();
    expect(questionOf({ question: "Q", options: [] })).toBeNull();
    expect(questionOf(null)).toBeNull();
  });
  it("sends trimmed answers and nothing for blanks", () => {
    expect(answerInput("  PDF ")).toEqual({ answer: "PDF" });
    expect(answerInput("   ")).toBeNull();
    expect(answerInput("x".repeat(3000))?.answer.length).toBe(2000);
  });
  it("titles the Needs you row with the question", () => {
    const ask = { question: "Which report format?", options: [{ label: "PDF" }], allowOther: true };
    expect(questionTitle("Nova", ask)).toBe("Nova asks: Which report format?");
  });
});
