/**
 * The live takeover's keyboard: a hidden field inside the picture that holds
 * focus while the owner types. A real keyboard is read key by key
 * (`keyDecision`: printable text and the page's named keys go to the page,
 * Escape gives focus back). A PHONE's keyboard opens only for an editable
 * field and sends its text as `input`, so whatever lands in the field is read
 * back as acts (`catcherActs`) and the field is reset; words a phone keyboard
 * composes reach the page when it commits them. A paste (Ctrl/Cmd-V, or a
 * phone's long-press Paste) goes to the page as typing — the way to bring a
 * password or a code from a password manager.
 */
import { useRef, type ClipboardEvent, type KeyboardEvent, type RefObject } from "react";
import { catcherActs, keyDecision, KEY_SENTINEL, textActs } from "@/lib/cast-keys";
import type { TakeoverCast } from "@/lib/takeover-cast";

/** Focus the field from a tap; refocusing brings back a keyboard the owner dismissed. */
export const summonKeys = (field: HTMLTextAreaElement | null): void => {
  if (field === null) return;
  if (document.activeElement === field) field.blur();
  field.focus({ preventScroll: true });
};

export function KeyCatcher({
  cast,
  ref,
}: {
  cast: TakeoverCast;
  ref: RefObject<HTMLTextAreaElement | null>;
}) {
  // A keystroke already sent from keydown: the input it may still cause is dropped.
  const handled = useRef(false);
  const composing = useRef(false);

  const read = (): void => {
    const field = ref.current;
    if (field === null) return;
    const value = field.value;
    field.value = KEY_SENTINEL;
    field.setSelectionRange(KEY_SENTINEL.length, KEY_SENTINEL.length);
    if (handled.current) {
      handled.current = false;
      return;
    }
    for (const act of catcherActs(value)) cast.send(act);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // A phone keyboard (keyCode 229) or a word mid-composition: its text comes as input.
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      handled.current = false;
      return;
    }
    const decision = keyDecision(event);
    handled.current = decision.send !== "passthrough";
    if (decision.send === "passthrough") return;
    event.preventDefault();
    if (decision.send === "escape") {
      cast.flush();
      ref.current?.blur();
      return;
    }
    if (decision.send === "key") cast.send({ a: "key", key: decision.key });
    else cast.send({ a: "type", text: decision.text });
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    event.preventDefault();
    handled.current = false;
    for (const act of textActs(event.clipboardData.getData("text/plain"))) cast.send(act);
  };

  return (
    <textarea
      ref={ref}
      aria-label="Type into the page"
      defaultValue={KEY_SENTINEL}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      rows={1}
      // 16px text: a smaller field makes iOS zoom the whole app on focus.
      className="absolute top-0 left-0 size-px resize-none overflow-hidden border-0 p-0 text-base opacity-0"
      onKeyDown={onKeyDown}
      onKeyUp={() => {
        handled.current = false;
      }}
      onPaste={onPaste}
      onInput={() => {
        if (!composing.current) read();
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        read();
      }}
      onBlur={() => cast.flush()}
    />
  );
}
