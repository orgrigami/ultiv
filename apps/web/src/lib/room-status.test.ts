import { describe, expect, it } from "vite-plus/test";
import { deliveryNote, reasonOf } from "./room-status.ts";

describe("deliveryNote", () => {
  it("shows nothing for a delivered message", () => {
    expect(deliveryNote({ status: "replied", error: null })).toBeNull();
    expect(deliveryNote({ error: null })).toBeNull();
  });

  it("says a pending message is retrying when an attempt failed", () => {
    expect(deliveryNote({ status: "pending", error: null })?.label).toBe("Waiting for a reply");
    expect(
      deliveryNote({ status: "pending", error: "The reply failed: model returned an error" }),
    ).toEqual({
      label: "Delivery failed, trying again",
      reason: "The reply failed: model returned an error.",
      tone: "muted",
    });
  });

  it("never claims three tries for a message refused at once", () => {
    const note = deliveryNote({ status: "dead", error: "recipient has no message tool" });
    expect(note?.label).toBe("Couldn't be delivered");
    expect(note?.reason).toContain("message tool is off");
  });

  it("keeps the deadline in a timeout and drops a redundant cancel reason", () => {
    expect(deliveryNote({ status: "expired", error: "no reply within 15 minutes" })?.reason).toBe(
      "No reply within 15 minutes.",
    );
    expect(
      deliveryNote({ status: "cancelled", error: "cancelled by the owner" })?.reason,
    ).toBeNull();
  });
});

describe("reasonOf", () => {
  it("drops legacy tags and empty objects", () => {
    expect(reasonOf("spriessen/External")).toBeNull();
    expect(reasonOf("[object Object]")).toBeNull();
    expect(reasonOf("Error: ")).toBeNull();
  });

  it("strips an error-class prefix", () => {
    expect(reasonOf("Error: the recipient's conversation for this talk is missing")).toBe(
      "The recipient's conversation for this talk is missing.",
    );
  });
});
