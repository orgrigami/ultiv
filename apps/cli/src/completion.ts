/**
 * Shell completion, generated from the command table (table.ts): command
 * names, each command's second words (`chats show`, `daemon install`…) and
 * its flags. Static on purpose — completing bot names would need a
 * signed-in call to the server on every tab.
 */
import { COMMANDS, GLOBAL_FLAGS } from "./table.ts";

const flagsOf = (name: string): string[] => {
  const spec = COMMANDS.find((candidate) => candidate.name === name);
  return [...Object.keys(spec?.flags ?? {}), ...Object.keys(GLOBAL_FLAGS)].map((f) => `--${f}`);
};

const names = (): string => ["help", ...COMMANDS.map((spec) => spec.name)].join(" ");

export const bashCompletion = (): string => {
  const cases = COMMANDS.map(
    (spec) =>
      `    ${spec.name}) subs="${(spec.subcommands ?? []).join(" ")}"; flags="${flagsOf(spec.name).join(" ")}" ;;`,
  ).join("\n");
  return `# spriessen completion (bash): eval "$(spriessen completion bash)"
_spriessen() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" cmd="\${COMP_WORDS[1]}" subs="" flags=""
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${names()}" -- "$cur"))
    return
  fi
  case "$cmd" in
${cases}
    help) subs="${COMMANDS.map((spec) => spec.name).join(" ")}" ;;
  esac
  if [[ "$cur" == --* ]]; then
    COMPREPLY=($(compgen -W "$flags" -- "$cur"))
  elif [ "$COMP_CWORD" -eq 2 ] && [ -n "$subs" ]; then
    COMPREPLY=($(compgen -W "$subs" -- "$cur"))
  else
    COMPREPLY=($(compgen -f -- "$cur"))
  fi
}
complete -F _spriessen spriessen
`;
};

export const zshCompletion = (): string =>
  `# spriessen completion (zsh): eval "$(spriessen completion zsh)"
autoload -U +X bashcompinit && bashcompinit
${bashCompletion()}`;

export const fishCompletion = (): string => {
  const lines = [
    "# spriessen completion (fish): spriessen completion fish > ~/.config/fish/completions/spriessen.fish",
    "complete -c spriessen -f",
  ];
  for (const spec of COMMANDS) {
    lines.push(
      `complete -c spriessen -n __fish_use_subcommand -a ${spec.name} -d ${JSON.stringify(spec.summary)}`,
    );
    for (const sub of spec.subcommands ?? []) {
      lines.push(`complete -c spriessen -n "__fish_seen_subcommand_from ${spec.name}" -a ${sub}`);
    }
    const flags = { ...spec.flags, ...GLOBAL_FLAGS };
    for (const [flag, about] of Object.entries(flags)) {
      lines.push(
        `complete -c spriessen -n "__fish_seen_subcommand_from ${spec.name}" -l ${flag} -d ${JSON.stringify(about)}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
};
