import { describe, expect, it } from "vite-plus/test";
import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";
import { projectTranscript } from "./steps.ts";

const entry = (id: number, messages: readonly unknown[]): EntryRecord =>
  ({ id, model: messages }) as EntryRecord;

describe("projectTranscript", () => {
  it("projects input, output, thinking, and paired tool steps", () => {
    const steps = projectTranscript(
      [
        entry(1, [{ role: "user", content: "hello", timestamp: 100 }]),
        entry(2, [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "pondering" },
              { type: "toolCall", id: "call_1", name: "jev_score", arguments: { a: 1 } },
              { type: "text", text: "done" },
            ],
            timestamp: 200,
          },
        ]),
        entry(3, [
          {
            role: "toolResult",
            toolCallId: "call_1",
            content: "0.9",
            isError: false,
            durationMs: 12,
          },
        ]),
      ],
      undefined,
      false,
    );
    expect(steps.map((step) => step.kind)).toEqual(["input", "thinking", "tool", "output"]);
    const tool = steps[2];
    expect(tool).toMatchObject({
      kind: "tool",
      step: { callId: "call_1", name: "jev_score", status: "done", output: "0.9", durationMs: 12 },
    });
  });

  it("marks an aborted reply interrupted, even one cut while thinking", () => {
    const aborted = (content: unknown[]) => ({
      role: "assistant",
      content,
      stopReason: "aborted",
      timestamp: 300,
    });
    const steps = projectTranscript(
      [
        entry(1, [aborted([{ type: "text", text: "half an essay" }])]),
        entry(2, [aborted([{ type: "thinking", thinking: "hmm" }])]),
      ],
      undefined,
      false,
    );
    expect(steps).toMatchObject([
      { kind: "output", text: "half an essay", interrupted: true },
      { kind: "thinking" },
      { kind: "output", text: "", interrupted: true },
    ]);
  });

  it("streams the live partial with negative ids and skips settled prefixes", () => {
    const live = {
      generation: { message: { content: [{ type: "text", text: "hel" }], timestamp: 300 } },
    } as LiveState;
    const fresh = projectTranscript([], live, false);
    expect(fresh).toEqual([{ id: -1000, kind: "output", at: 300, text: "hel", streaming: true }]);
    const settled = projectTranscript(
      [
        entry(1, [
          { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 200 },
        ]),
      ],
      live,
      false,
    );
    // "hel" is a prefix of the settled "hello": the partial must not duplicate it.
    expect(settled).toHaveLength(1);
  });

  it("marks the newest output streaming while working", () => {
    const steps = projectTranscript(
      [
        entry(1, [
          { role: "assistant", content: [{ type: "text", text: "partial" }], timestamp: 1 },
        ]),
      ],
      undefined,
      true,
    );
    expect(steps[0]).toMatchObject({ kind: "output", text: "partial", streaming: true });
  });

  it("carries a tool result's details onto the step only when present", () => {
    const call = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "c1", name: "artifact_write", arguments: { name: "r.md" } },
      ],
      timestamp: 10,
    };
    const withDetails = projectTranscript(
      [
        entry(1, [call]),
        entry(2, [
          {
            role: "toolResult",
            toolCallId: "c1",
            content: "saved",
            isError: false,
            durationMs: 5,
            details: { id: "a1", name: "r.md", mime: "text/markdown", bytes: 2 },
          },
        ]),
      ],
      undefined,
      false,
    );
    const done = withDetails[0];
    expect(done?.kind).toBe("tool");
    expect(done !== undefined && done.kind === "tool" && done.step).toMatchObject({
      status: "done",
      details: { id: "a1", name: "r.md", mime: "text/markdown", bytes: 2 },
    });
    const withoutDetails = projectTranscript(
      [
        entry(1, [call]),
        entry(2, [
          { role: "toolResult", toolCallId: "c1", content: "saved", isError: false, durationMs: 5 },
        ]),
      ],
      undefined,
      false,
    );
    const tool = withoutDetails[0];
    expect(tool?.kind === "tool" && "details" in tool.step).toBe(false);
  });

  it("carries attachment refs on the input step and never leaks base64", () => {
    const steps = projectTranscript(
      [
        {
          id: 1,
          kind: "ultiv.input",
          data: { attachments: [{ id: "a1", name: "shot.png", mime: "image/png", bytes: 4 }] },
          model: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: 'what\'s in this picture?\n\nAttached artifacts:\n- "shot.png" (image/png): included as an image in this message',
                },
                { type: "image", data: "QUJD", mimeType: "image/png" },
              ],
              timestamp: 100,
            },
          ],
        } as unknown as EntryRecord,
      ],
      undefined,
      false,
    );
    const input = steps.find((step) => step.kind === "input");
    expect(input !== undefined && input.kind === "input" && input.attachments).toEqual([
      { id: "a1", name: "shot.png", mime: "image/png", bytes: 4 },
    ]);
    const inputText = input !== undefined && input.kind === "input" ? input.text : "";
    expect(inputText).toBe("what's in this picture?");
    expect(JSON.stringify(steps)).not.toContain("QUJD");
  });

  it("shows a text-only message from an ultiv.input entry without refs", () => {
    const steps = projectTranscript(
      [
        {
          id: 1,
          kind: "ultiv.input",
          data: {},
          model: [{ role: "user", content: "plain", timestamp: 100 }],
        } as unknown as EntryRecord,
      ],
      undefined,
      false,
    );
    expect(steps).toEqual([{ id: 100, kind: "input", at: 100, text: "plain" }]);
  });
});
