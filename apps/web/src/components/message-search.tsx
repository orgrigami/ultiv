/**
 * Messages on Past chats: what was said in the bots' chats, found by the
 * words typed in the filter. Each bot's chats are searched on their own
 * (the same search the bot runs with history_search) and shown under that
 * bot; a hit opens its chat. Debounced, cancelled when the words change.
 */
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { HistoryHit, HistorySearch } from "@spriessen/contracts";
import { BotAvatar } from "@/components/bot-avatar";
import { SectionHeader } from "@/components/ui/section-header";
import { Tile } from "@/components/ui/tile";
import { SkeletonRows } from "@/components/ui/skeleton";
import { RowButton } from "@/components/ui/row-button";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { formatWhen } from "@/lib/format";
import { highlightParts, MIN_QUERY, speakerOf } from "@/lib/message-search";

const DEBOUNCE_MS = 300;

type State =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "done"; readonly result: HistorySearch }
  | { readonly kind: "failed"; readonly message: string };

function useMessageSearch(query: string): State {
  const [state, setState] = useState<State>({ kind: "idle" });
  useEffect(() => {
    const words = query.trim();
    if (words.length < MIN_QUERY) {
      setState({ kind: "idle" });
      return;
    }
    let stale = false;
    setState({ kind: "loading" });
    const timer = setTimeout(() => {
      api
        .historySearch(words)
        .then((result) => {
          if (!stale) setState({ kind: "done", result });
        })
        .catch((cause: unknown) => {
          if (!stale)
            setState({
              kind: "failed",
              message: cause instanceof Error ? cause.message : String(cause),
            });
        });
    }, DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query]);
  return state;
}

function Snippet({ text, query }: { text: string; query: string }) {
  return (
    <span className="line-clamp-3 text-sm">
      {highlightParts(text, query).map((part, index) =>
        part.hit ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a static split of one string
          <mark key={index} className="bg-accent text-foreground rounded-sm px-0.5">
            {part.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a static split of one string
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

function HitRow({
  hit,
  botId,
  botName,
  query,
}: {
  hit: HistoryHit;
  botId: string;
  botName: string;
  query: string;
}) {
  const navigate = useNavigate();
  const { mainId } = useApp();
  const open = (): void => {
    if (hit.kind === "main")
      void navigate({ to: "/", search: botId === mainId ? {} : { bot: botId } });
    else void navigate({ to: "/c/$sessionId", params: { sessionId: hit.sessionId } });
  };
  const chat = hit.kind === "main" ? "Main chat" : hit.sessionTitle;
  return (
    <li>
      <RowButton
        onClick={open}
        className="hover:bg-muted/60 press flex w-full flex-col gap-1 rounded-2xl px-3 py-2.5 text-left"
      >
        <Snippet text={hit.snippet} query={query} />
        <span className="text-muted-foreground truncate text-xs">
          {speakerOf(hit, botName)} · {chat}
          {hit.at > 0 ? ` · ${formatWhen(hit.at)}` : ""}
        </span>
      </RowButton>
    </li>
  );
}

/** The Messages section; renders nothing until the words are long enough. */
export function MessageSearch({ query }: { query: string }) {
  const { sessions } = useApp();
  const state = useMessageSearch(query);
  if (state.kind === "idle") return null;
  const nameOf = (id: string): string =>
    sessions.profiles.find((profile) => profile.id === id)?.name ?? "A bot";
  return (
    <section aria-label="Messages" className="flex flex-col gap-2">
      <SectionHeader title="Messages" className="px-1" />
      {state.kind === "loading" && <SkeletonRows label="Searching messages" rows={2} />}
      {state.kind === "failed" && (
        <p className="text-muted-foreground px-1 text-sm">
          Couldn't search messages: {state.message}
        </p>
      )}
      {state.kind === "done" && state.result.groups.length === 0 && (
        <p className="text-muted-foreground px-1 py-2 text-sm">No message says that.</p>
      )}
      {state.kind === "done" &&
        state.result.groups.map((group) => (
          <Tile key={group.profile} radius="2xl">
            <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
              <BotAvatar id={group.profile} name={nameOf(group.profile)} size="sm" />
              <span className="text-sm font-medium">{nameOf(group.profile)}</span>
            </div>
            <ul
              aria-label={`Messages in ${nameOf(group.profile)}'s chats`}
              className="divide-border divide-y"
            >
              {group.hits.map((hit) => (
                <HitRow
                  key={`${hit.sessionId}:${hit.at}:${hit.snippet.slice(0, 24)}`}
                  hit={hit}
                  botId={group.profile}
                  botName={nameOf(group.profile)}
                  query={state.result.query}
                />
              ))}
            </ul>
          </Tile>
        ))}
    </section>
  );
}
