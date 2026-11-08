/**
 * The Edit-bot dialog's numbers: the two turn deadlines and how many
 * background tasks the bot runs at once. Each checks itself as you type, in
 * the server's own words; empty means the default.
 */
import { Input } from "@/components/ui/input";
import { deadlineFieldProblem } from "@/lib/deadline-fields";
import type { PolicyNumberField } from "@spriessen/contracts";

export type LimitsForm = {
  readonly firstTokenSec?: string;
  readonly turnMin?: string;
  readonly taskLimit?: string;
  readonly tokenBudget?: string;
};

function NumberField({
  label,
  field,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  field: PolicyNumberField;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const problem = deadlineFieldProblem(value, field);
  return (
    <label className="flex flex-1 flex-col gap-1 text-xs">
      {label}
      <Input
        inputMode="numeric"
        placeholder={placeholder}
        value={value}
        aria-invalid={problem !== null}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem !== null && (
        <span role="alert" className="text-destructive">
          {problem}
        </span>
      )}
    </label>
  );
}

export function BotLimits({
  form,
  taskDefault,
  spendToday,
  onChange,
}: {
  form: LimitsForm;
  /** The workspace default the empty task field means (Settings). */
  taskDefault: number | undefined;
  /** What the bot already spent today (the daily ledger); absent = unknown. */
  spendToday?: number | undefined;
  onChange: (next: LimitsForm) => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-1 text-sm">
        <span>Deadlines</span>
        <div className="flex gap-2">
          <NumberField
            label="First reply (seconds)"
            field="firstTokenDeadlineSec"
            placeholder="60"
            value={form.firstTokenSec ?? ""}
            onChange={(firstTokenSec) => onChange({ ...form, firstTokenSec })}
          />
          <NumberField
            label="Whole turn (minutes)"
            field="turnDeadlineMin"
            placeholder="15"
            value={form.turnMin ?? ""}
            onChange={(turnMin) => onChange({ ...form, turnMin })}
          />
        </div>
        <span className="text-muted-foreground text-xs">
          A model call that sends nothing, or a turn that runs longer, is stopped with a note in the
          chat. Leave empty for the default. Approval waits don't count.
        </span>
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <span>Background tasks</span>
        <NumberField
          label="Tasks at once"
          field="maxRunningTasks"
          placeholder={taskDefault === undefined ? "default" : String(taskDefault)}
          value={form.taskLimit ?? ""}
          onChange={(taskLimit) => onChange({ ...form, taskLimit })}
        />
        <span className="text-muted-foreground text-xs">
          This bot's chats hand their work to background tasks. More than this many wait in its
          queue and start by themselves. Leave empty for the default in Settings.
        </span>
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <span>Daily budget</span>
        <NumberField
          label="Tokens per day"
          field="dailyTokenBudget"
          placeholder="uncapped"
          value={form.tokenBudget ?? ""}
          onChange={(tokenBudget) => onChange({ ...form, tokenBudget })}
        />
        <span className="text-muted-foreground text-xs">
          At the budget no new tasks start until tomorrow; the bot tells you when it happens. Chats
          with you always run.
          {spendToday !== undefined && ` Today so far: ${spendToday.toLocaleString()} tokens.`}
        </span>
      </div>
    </>
  );
}
