/**
 * The approval card in the chat: "<bot> wants to …", the one telling input,
 * the risk line, and the keys that answer it. While a card waits it holds
 * the keyboard (app.tsx): a approve · d deny · A always allow (only where
 * the web offers it; floors never) · i back to typing.
 */
import type { PendingApproval } from "@spriessen/contracts";
import { cardWords } from "../render/words.ts";
import { THEME } from "./theme.ts";

export const ApprovalCard = ({
  pending,
  bot,
  focused,
}: {
  pending: NonNullable<PendingApproval>;
  bot: string;
  focused: boolean;
}) => {
  const words = cardWords(pending);
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={focused ? THEME.signal : THEME.rule}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      flexShrink={0}
    >
      <text fg={THEME.ink}>
        <strong>
          {bot} wants to {words.action}
        </strong>
      </text>
      {words.hint !== null ? <text fg={THEME.muted}>{words.hint}</text> : null}
      <text fg={words.risky ? THEME.live : THEME.faint}>{words.risk}</text>
      <text fg={THEME.faint}>
        <span fg={THEME.ok}>a</span> approve · <span fg={THEME.signal}>d</span> deny
        {words.always !== null ? (
          <>
            {" · "}
            <span fg={THEME.ink}>A</span> {words.always.toLocaleLowerCase("en")}
          </>
        ) : null}
        {focused ? " · i type instead" : " · esc to answer"}
      </text>
    </box>
  );
};
