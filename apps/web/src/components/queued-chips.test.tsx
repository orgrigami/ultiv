import { describe, expect, it, vi } from "vite-plus/test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueuedChips } from "./queued-chips.tsx";
import { canSend } from "./send-button.tsx";
import { queueLabel, STALLED_LABEL, turnActivity } from "../lib/queue-text.ts";

const QUEUED = [
  { id: "7", text: "also check the weather", mode: "steer" as const },
  { id: "9", text: "then book it", mode: "followUp" as const },
];

/** Every element in a rendered tree (function components are not expanded). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

describe("Send while busy", () => {
  it("stays enabled while the bot works; only link, sending or an empty draft disable it", () => {
    expect(canSend(true, false, "and also this")).toBe(true);
    expect(canSend(false, false, "x")).toBe(false);
    expect(canSend(true, true, "x")).toBe(false);
    expect(canSend(true, false, "   ")).toBe(false);
  });
});

describe("QueuedChips", () => {
  it("renders each queued message with when it will send", () => {
    const html = renderToStaticMarkup(
      <QueuedChips queued={QUEUED} approvalPending={false} onWithdraw={() => {}} />,
    );
    expect(html).toContain("also check the weather");
    expect(html).toContain("Will send at the next step");
    expect(html).toContain("Will send after it finishes");
    expect(html).toContain('aria-label="Cancel queued message: then book it"');
  });

  it("tells the truth about when a steered message lands", () => {
    const tool = {
      id: 1,
      kind: "tool" as const,
      at: 0,
      step: {
        callId: "c",
        name: "web_search",
        status: "running" as const,
        input: null,
        output: null,
        durationMs: null,
      },
    };
    const writing = { id: 2, kind: "output" as const, at: 0, text: "Here is", streaming: true };
    expect(turnActivity([tool])).toBe("working");
    expect(turnActivity([tool, writing])).toBe("writing");
    expect(turnActivity([])).toBe("working");
    expect(queueLabel("steer", false, "writing")).toBe("Will answer right after this reply");
    expect(queueLabel("steer", false, "working")).toBe("Will send at the next step");
    expect(queueLabel("followUp", false, "writing")).toBe("Will send after it finishes");
    expect(queueLabel("steer", true, "writing")).toBe("Waiting for your approval first");
    const html = renderToStaticMarkup(
      <QueuedChips
        queued={QUEUED}
        approvalPending={false}
        activity="writing"
        onWithdraw={() => {}}
      />,
    );
    expect(html).toContain("Will answer right after this reply");
    expect(html).toContain("Pending message: also check the weather");
  });

  it("says an approval comes first, and renders nothing when the queue is empty", () => {
    expect(queueLabel("steer", true)).toBe("Waiting for your approval first");
    const empty = renderToStaticMarkup(
      <QueuedChips queued={[]} approvalPending={false} onWithdraw={() => {}} />,
    );
    expect(empty).toBe("");
  });

  it("after a failed turn: says not sent and offers Retry, which is the only way they send (D3)", () => {
    const onRetry = vi.fn();
    const busy = renderToStaticMarkup(
      <QueuedChips
        queued={QUEUED}
        approvalPending={false}
        onWithdraw={() => {}}
        onRetry={onRetry}
      />,
    );
    expect(busy).not.toContain("Retry");
    const tree = QueuedChips({
      queued: QUEUED,
      approvalPending: false,
      onWithdraw: () => {},
      stalled: true,
      onRetry,
    });
    const html = renderToStaticMarkup(<>{tree}</>);
    expect(html).toContain(STALLED_LABEL);
    expect(html).not.toContain("Will send");
    const retry = elements(tree).filter(
      (el) => el.props["aria-label"] === "Retry: send the 2 queued messages",
    );
    expect(retry).toHaveLength(1);
    expect(onRetry).not.toHaveBeenCalled();
    (retry[0]!.props.onClick as () => void)();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("the x withdraws that message", () => {
    const onWithdraw = vi.fn();
    const tree = QueuedChips({ queued: QUEUED, approvalPending: false, onWithdraw });
    const cancels = elements(tree).filter((el) =>
      String(el.props["aria-label"] ?? "").startsWith("Cancel queued message"),
    );
    expect(cancels).toHaveLength(2);
    (cancels[1]!.props.onClick as () => void)();
    expect(onWithdraw).toHaveBeenCalledWith("9");
  });
});
