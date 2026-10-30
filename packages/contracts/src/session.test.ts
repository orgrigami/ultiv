import { describe, expect, it } from "vite-plus/test";
import { AttachmentRefSchema, Session, ToolStepSchema } from "./session.ts";

describe("Session contract", () => {
  it("is a remote contract, version 17, hosted on the server", () => {
    expect(Session.scope).toBe("remote");
    expect(Session.def.version).toBe(17);
  });

  it("carries an optional details channel on tool steps", () => {
    expect(ToolStepSchema.properties).toMatchObject({ details: expect.anything() });
  });

  it("lets input steps carry attachment refs, id name mime bytes", () => {
    expect(AttachmentRefSchema.properties).toMatchObject({
      id: expect.anything(),
      name: expect.anything(),
      mime: expect.anything(),
      bytes: expect.anything(),
    });
  });

  it("is addressed per session id", () => {
    expect(Session.def.input).toMatchObject({
      type: "object",
      required: ["id"],
    });
  });

  it("declares transcript, phase, lastError and pending approval state", () => {
    const variant = Session.def.variants.default;
    expect(variant).toBeDefined();
    expect(variant?.state).toMatchObject({
      transcript: { type: "array" },
      phase: expect.anything(),
      lastError: expect.anything(),
      pending: expect.anything(),
      usage: expect.anything(),
      model: expect.anything(),
      effort: expect.anything(),
    });
  });

  it("declares input, approve and configure methods", () => {
    const variant = Session.def.variants.default;
    expect(variant?.methods).toMatchObject({
      input: expect.anything(),
      approve: expect.anything(),
      configure: expect.anything(),
    });
  });
});
