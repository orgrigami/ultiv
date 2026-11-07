/**
 * A machinery message (system-text.ts) as ONE line of owner words, for the
 * terminal client: "Task finished: …", "Routine ran: …", "Message from
 * Wren: …". The web draws the same messages as cards; null means the
 * message is hidden (resume notes, the onboarding seed).
 */
import { isNothingToReport, NOTHING_TO_REPORT_WORDS } from "@spriessen/contracts";
import { firstLine, type SystemMessage } from "./system-text.ts";

const TASK_WORDS = { done: "Task finished", failed: "Task failed", cancelled: "Task stopped" };

const withText = (head: string, text: string): string => {
  const line = firstLine(text, 100);
  return line === "" ? head : `${head}: ${line}`;
};

export function systemLine(message: SystemMessage): string | null {
  switch (message.kind) {
    case "hidden":
      return null;
    case "task":
      if (message.outcome === "done" && isNothingToReport(message.body))
        return NOTHING_TO_REPORT_WORDS;
      return withText(TASK_WORDS[message.outcome], message.body);
    case "task-update":
      return withText("Task update", message.text);
    case "webhook":
      return `Webhook ${message.webhookId}${message.event !== null ? ` (${message.event})` : ""} arrived${message.contextOnly ? ", context only" : ""}`;
    case "cron":
      return withText("Routine ran", message.text);
    case "sensor":
      return withText(`Watch ${message.source}`, message.text);
    case "bot": {
      const topic = message.topic !== null ? ` · ${message.topic}` : "";
      const head =
        message.direction === "out"
          ? `Sent to ${message.who}${topic}`
          : `${message.reply ? "Reply" : "Message"} from ${message.who}${topic}`;
      return withText(head, message.body);
    }
    case "nack":
      return `${message.who} couldn't take the message: ${message.reason}`;
    case "quiet":
      return withText("You (relayed)", message.text);
    case "access":
      return withText("Access changed", message.text);
    case "job":
      if (message.outcome === "lost")
        return withText("Background job lost in a restart", message.title);
      return withText(
        message.exitCode === 0
          ? "Background job finished"
          : `Background job failed (exit ${message.exitCode ?? "?"})`,
        message.title,
      );
  }
}
