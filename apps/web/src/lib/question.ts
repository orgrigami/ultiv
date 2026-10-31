/**
 * The ask_user_question card's data: the question and options read
 * tolerantly from the waiting call's input, and the answer it sends back.
 */
export const ASK_USER_QUESTION = "ask_user_question";

export interface QuestionOption {
  readonly label: string;
  readonly detail?: string | undefined;
}

export interface QuestionAsk {
  readonly question: string;
  readonly options: readonly QuestionOption[];
  readonly allowOther: boolean;
}

export const MAX_ANSWER_CHARS = 2_000;

/** The card's content, or null when the input isn't a question. */
export const questionOf = (input: unknown): QuestionAsk | null => {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const question = typeof record.question === "string" ? record.question.trim() : "";
  const options = (Array.isArray(record.options) ? record.options : []).flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const { label, detail } = raw as Record<string, unknown>;
    if (typeof label !== "string" || label.trim() === "") return [];
    return [
      {
        label: label.trim(),
        ...(typeof detail === "string" && detail.trim() !== "" ? { detail: detail.trim() } : {}),
      },
    ];
  });
  if (question === "" || options.length === 0) return null;
  return { question, options, allowOther: record.allowOther !== false };
};

/** The decide override for one answer, or null when there is nothing to send. */
export const answerInput = (answer: string): { answer: string } | null => {
  const trimmed = answer.trim();
  return trimmed === "" ? null : { answer: trimmed.slice(0, MAX_ANSWER_CHARS) };
};

/** The Needs you line for a waiting question. */
export const questionTitle = (botName: string, ask: QuestionAsk): string => {
  const text = ask.question.length > 80 ? `${ask.question.slice(0, 77)}…` : ask.question;
  return `${botName} asks: ${text}`;
};
