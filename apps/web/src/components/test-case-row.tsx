/**
 * One saved test on a bot's Tests tab: the message it replays, what it
 * expects (phrases to say, tools to call or avoid, a rule Jev checks), an
 * inline editor for those, and remove. Lists are comma-separated in the
 * editor; empty fields mean "no expectation".
 */
import { useState } from "react";
import type { EvalCase, EvalExpect } from "@spriessen/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { notifyError } from "@/lib/notify";

const listOf = (text: string): string[] =>
  text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");

/** The expectations as one plain line, or null when there are none. */
export function expectLine(expect: EvalExpect): string | null {
  const parts = [
    ...(expect.contains?.length ? [`says ${expect.contains.map((p) => `"${p}"`).join(", ")}`] : []),
    ...(expect.tools?.length ? [`calls ${expect.tools.join(", ")}`] : []),
    ...(expect.notTools?.length ? [`never calls ${expect.notTools.join(", ")}`] : []),
    ...(expect.rubric ? [`rule: ${expect.rubric}`] : []),
  ];
  return parts.length === 0 ? null : parts.join(" · ");
}

function ExpectEditor({ item, onDone }: { item: EvalCase; onDone: () => void }) {
  const [says, setSays] = useState((item.expect.contains ?? []).join(", "));
  const [calls, setCalls] = useState((item.expect.tools ?? []).join(", "));
  const [never, setNever] = useState((item.expect.notTools ?? []).join(", "));
  const [rubric, setRubric] = useState(item.expect.rubric ?? "");
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    setBusy(true);
    const expect: EvalExpect = {
      ...(listOf(says).length > 0 ? { contains: listOf(says) } : {}),
      ...(listOf(calls).length > 0 ? { tools: listOf(calls) } : {}),
      ...(listOf(never).length > 0 ? { notTools: listOf(never) } : {}),
      ...(rubric.trim() !== "" ? { rubric: rubric.trim() } : {}),
    };
    try {
      await api.evalUpdate(item.id, { expect });
      onDone();
    } catch (cause) {
      notifyError("Couldn't save the expectations", cause);
      setBusy(false);
    }
  };
  const field = "flex flex-col gap-1 text-xs";
  return (
    <div className="flex flex-col gap-2 pt-2">
      <label className={field}>
        Must say (comma-separated)
        <Input value={says} onChange={(event) => setSays(event.target.value)} />
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className={`${field} flex-1`}>
          Must call tools
          <Input value={calls} onChange={(event) => setCalls(event.target.value)} />
        </label>
        <label className={`${field} flex-1`}>
          Must never call
          <Input value={never} onChange={(event) => setNever(event.target.value)} />
        </label>
      </div>
      <label className={field}>
        A rule Jev checks the reply against
        <Textarea rows={2} value={rubric} onChange={(event) => setRubric(event.target.value)} />
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={() => void save()} disabled={busy}>
          Save
        </Button>
      </div>
    </div>
  );
}

export function TestCaseRow({ item }: { item: EvalCase }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const expect = expectLine(item.expect);
  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.evalRemove(item.id);
    } catch (cause) {
      notifyError("Couldn't remove the test", cause);
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-col gap-1 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium break-words">{item.title}</span>
          <span className="text-muted-foreground line-clamp-2 text-xs break-words">
            {item.input}
          </span>
          <span className="text-muted-foreground text-xs">
            {expect ?? "No expectations: Jev compares the reply with the original one."}
          </span>
        </span>
        {!editing && (
          <>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Expect…
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void remove()}
            >
              Remove
            </Button>
          </>
        )}
      </div>
      {editing && <ExpectEditor item={item} onDone={() => setEditing(false)} />}
    </li>
  );
}
