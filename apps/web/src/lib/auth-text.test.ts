import { describe, expect, it } from "vite-plus/test";
import { authErrorText, authEventText, passkeyErrorText } from "./auth-text.ts";

describe("auth wording", () => {
  it("turns a throttle into a wait the person can act on", () => {
    expect(authErrorText(429, "too many attempts; wait 873s", "873")).toBe(
      "Too many attempts. Try again in 15 min.",
    );
    expect(authErrorText(429, undefined, "12")).toBe("Too many attempts. Try again in 12 s.");
    expect(authErrorText(429, undefined, null)).toBe("Too many attempts. Try again in a moment.");
  });

  it("makes the server's reason a sentence, with a fallback", () => {
    expect(authErrorText(401, "wrong passcode", null)).toBe("Wrong passcode.");
    expect(authErrorText(500, undefined, null)).toBe("That didn't work. Try again.");
  });

  it("names a closed passkey prompt instead of the browser's message", () => {
    const closed = Object.assign(new Error("The operation either timed out or was not allowed."), {
      name: "NotAllowedError",
    });
    expect(passkeyErrorText(closed)).toBe("The passkey prompt was closed or timed out.");
    expect(passkeyErrorText(new Error("No passkeys yet."))).toBe("No passkeys yet.");
  });

  it("shows sign-in audit rows in plain words", () => {
    expect(authEventText("sign-in", true)).toBe("Signed in");
    expect(authEventText("sign-in", false, "wrong passcode")).toBe(
      "Sign-in refused: wrong passcode",
    );
    expect(authEventText("passcode-change", false, "refused: throttled")).toBe(
      "Passcode change refused: too many attempts",
    );
    expect(authEventText("passkey-removed", true)).toBe("Passkey removed");
    expect(authEventText("something-new", true)).toBe("something-new");
  });
});
