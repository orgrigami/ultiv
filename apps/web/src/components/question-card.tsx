/**
 * The ask_user_question card, in the chat and in Needs you: the bot's
 * question with each option as a button, a box for the owner's own answer
 * (unless the bot turned it off), and Dismiss. Tapping an option answers at
 * once; the answer rides the approval's override and continues the turn.
 */
import { MessageCircleQuestionIcon } from "lucide-react";
import { useState } from "react";
import type { DecideOutcome } from "@/components/approval-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { answerInput, MAX_ANSWER_CHARS, type QuestionAsk } from "@/lib/question";
import { Tile } from "@/components/ui/tile";

export function QuestionCard({
  ask,
  who,
  onDecide,
}: {
  ask: QuestionAsk;
  who?: string | undefined;
  onDecide: (
    approved: boolean,
    always?: boolean,
    takeover?: boolean,
    input?: unknown,
  ) => Promise<DecideOutcome | void>;
}) {
  const [other, setOther] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = sending !== null;

  const send = async (key: string, run: () => Promise<DecideOutcome | void>): Promise<void> => {
    setSending(key);
    setError(null);
    try {
      await run();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(null);
    }
  };
  const answer = (key: string, text: string): void => {
    const input = answerInput(text);
    if (input !== null) void send(key, () => onDecide(true, false, false, input));
  };

  return (
    <Tile
      role="group"
      aria-label="Question for you"
      className="flex w-full flex-col gap-3 p-3"
    >
      <p className="flex items-start gap-2 text-sm">
        <MessageCircleQuestionIcon className="text-live mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="min-w-0">
          <span className="text-muted-foreground block text-xs">{who ?? "Your bot"} asks</span>
          <span className="font-medium whitespace-pre-wrap">{ask.question}</span>
        </span>
      </p>
      <div className="flex flex-col gap-2">
        {ask.options.map((option, index) => (
          <Button
            key={`${index}-${option.label}`}
            variant="outline"
            size="fit"
            className="w-full flex-col items-start text-left whitespace-normal"
            disabled={busy}
            onClick={() => answer(`option-${index}`, option.label)}
          >
            <span className="font-medium">
              {sending === `option-${index}` ? "Sending…" : option.label}
            </span>
            {option.detail !== undefined && (
              <span className="text-muted-foreground text-xs font-normal">{option.detail}</span>
            )}
          </Button>
        ))}
      </div>
      {ask.allowOther && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            answer("other", other);
          }}
        >
          <Input
            value={other}
            maxLength={MAX_ANSWER_CHARS}
            placeholder="Or type your own answer"
            aria-label="Your own answer"
            disabled={busy}
            onChange={(event) => setOther(event.target.value)}
          />
          <Button type="submit" disabled={busy || other.trim() === ""}>
            {sending === "other" ? "Sending…" : "Send"}
          </Button>
        </form>
      )}
      {error !== null && (
        <p role="alert" className="text-destructive text-xs">
          Couldn't send: {error}
        </p>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        disabled={busy}
        onClick={() => void send("dismiss", () => onDecide(false))}
      >
        {sending === "dismiss" ? "Sending…" : "Dismiss"}
      </Button>
    </Tile>
  );
}
