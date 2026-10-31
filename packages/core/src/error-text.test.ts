import { describe, expect, it } from "vite-plus/test";
import { Data } from "effect";

// The kernel error shapes as `./errors.ts` defines them (same tags, same fields).
class NotFound extends Data.TaggedError("spriessen/NotFound")<{ readonly what: string }> {}
class InvalidInput extends Data.TaggedError("spriessen/InvalidInput")<{
  readonly reason: string;
}> {}
class Duplicate extends Data.TaggedError("spriessen/Duplicate")<{
  readonly kind: string;
  readonly id: string;
}> {}
class Unavailable extends Data.TaggedError("spriessen/Unavailable")<{
  readonly faculty: string;
  readonly why: string;
}> {}
class External extends Data.TaggedError("spriessen/External")<{
  readonly op: string;
  readonly cause: unknown;
}> {}
import { ownerErrorText, scrubSecrets } from "./error-text.ts";

describe("ownerErrorText (bug 2: the failed-turn banner)", () => {
  it("reads an External with an op and an Error cause as a sentence, not the tag", () => {
    const error = new External({ op: "submit", cause: new Error("connection reset by peer") });
    expect(String(error)).toBe("spriessen/External");
    const text = ownerErrorText(error);
    expect(text).toBe("Sending the message failed: connection reset by peer.");
    expect(text).not.toContain("spriessen/");
  });

  it("turns the engine's unanswered reasons into plain words", () => {
    const noModel = new External({
      op: "agent turn",
      cause: 'agent unanswered: {"status":"unanswered","reason":"no_model"}',
    });
    expect(ownerErrorText(noModel)).toBe(
      "No model is set for this chat. Pick one in the model menu and try again.",
    );
    const modelError = new External({
      op: "agent turn",
      cause:
        'agent unanswered: {"status":"unanswered","reason":"model_error","detail":"invalid request: bad"}',
    });
    expect(ownerErrorText(modelError)).toBe("The model returned an error: invalid request: bad.");
  });

  it("reads NotFound, InvalidInput and the other kernel errors as plain sentences", () => {
    expect(ownerErrorText(new NotFound({ what: "that chat" }))).toBe("Couldn't find that chat.");
    expect(ownerErrorText(new InvalidInput({ reason: "the message is empty" }))).toBe(
      "Not accepted: the message is empty.",
    );
    expect(ownerErrorText(new Unavailable({ faculty: "Search", why: "no key is set" }))).toBe(
      "Search isn't available: no key is set.",
    );
    expect(ownerErrorText(new Duplicate({ kind: "Tool", id: "lookup" }))).toBe(
      "Tool lookup already exists.",
    );
  });

  it("reads a nested tagged cause", () => {
    const error = new External({ op: "commit", cause: new NotFound({ what: "the conversation" }) });
    expect(ownerErrorText(error)).toBe("Saving the reply failed: Couldn't find the conversation.");
  });

  it("falls back to 'Something went wrong' plus the op", () => {
    expect(ownerErrorText(new External({ op: "agent wait", cause: undefined }))).toBe(
      "Something went wrong (agent wait).",
    );
    expect(ownerErrorText({})).toBe("Something went wrong.");
    expect(ownerErrorText(undefined)).toBe("Something went wrong.");
  });

  it("never shows a secret-looking value from the cause", () => {
    const secret = "f3a9c2d4e5b6a7980a1b2c3d4e5f6a7b";
    const error = new External({
      op: "agent turn",
      cause: new Error(
        `request to https://api.test.invalid/v1?token=${secret}&q=1 failed; Authorization: Bearer ${secret}`,
      ),
    });
    const text = ownerErrorText(error);
    expect(text).not.toContain(secret);
    expect(text).toContain("token=•••");
    expect(text).toMatch(/^The reply failed: /);
    expect(scrubSecrets("x-api-key: abc123 and sk-test_0123456789abcdef")).not.toMatch(
      /abc123|0123456789abcdef/,
    );
  });
});
