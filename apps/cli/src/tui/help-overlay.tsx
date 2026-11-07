/**
 * /help in the TUI: every key and every slash command on one panel, read
 * from the same tables that run them (use-keys.ts's KEY_HELP, slash.ts's
 * SLASH_COMMANDS). ↑/↓ scroll a short terminal; esc closes it.
 */
import { useTerminalDimensions } from "@opentui/react";
import { SLASH_COMMANDS } from "./slash.ts";
import { THEME } from "./theme.ts";
import { KEY_HELP } from "./use-keys.ts";

export const HelpOverlay = () => {
  const { height } = useTerminalDimensions();
  const needed = KEY_HELP.length + SLASH_COMMANDS.length + 6;
  return (
    <box
      position="absolute"
      top={1}
      left={2}
      width={74}
      height={Math.min(needed, height - 2)}
      border
      borderStyle="rounded"
      borderColor={THEME.live}
      backgroundColor={THEME.raised}
      title=" Help "
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <scrollbox focused flexGrow={1}>
        <text fg={THEME.faint}>Keys</text>
        {KEY_HELP.map(([key, about]) => (
          <text key={key}>
            <span fg={THEME.ink}>{key.padEnd(14)}</span>
            <span fg={THEME.muted}>{about}</span>
          </text>
        ))}
        <text fg={THEME.faint}> </text>
        <text fg={THEME.faint}>Commands (type in the message box; tab completes)</text>
        {SLASH_COMMANDS.map((spec) => (
          <text key={spec.name}>
            <span fg={THEME.ink}>
              {`/${spec.name}${spec.args !== undefined ? ` ${spec.args}` : ""}`.padEnd(14)}
            </span>
            <span fg={THEME.muted}>{spec.about}</span>
          </text>
        ))}
      </scrollbox>
      <text fg={THEME.faint}>//text sends "/text" · ↑/↓ scroll · esc closes this</text>
    </box>
  );
};
