/**
 * Webhook threads: an outside conversation (a GitHub issue, a chat thread, a
 * support ticket) gets ONE chat of its own, and every later payload on the
 * same thread continues it, so its history stays together instead of piling
 * into the bot's main chat. A webhook names where the thread id sits in the
 * payload (`threadKey`, a dotted path) and, optionally, its title.
 *
 * And who may start work: with `senders` set, only payloads from an allowed
 * sender start or wake work. Anyone else's payload reaches a thread that
 * already has a chat as CONTEXT ONLY (marked so the bot never takes it as a
 * request), and is ignored when no chat follows the thread: an outside
 * stranger can never open a chat or wake the bot. This is the
 * dsh-superagent gate (allowed lists, follow-ups reach the thread's work
 * without new authority), shaped as a webhook setting.
 */
import { MAX_WEBHOOK_THREADS, type WebhookInfo, type WebhookThread } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { updateWebhook } from "./webhooks.ts";

/** The chat a thread's payloads continue, when it still exists. */
export const knownThreadChat = async (
  profiles: Pick<ProfilesService, "rowOf">,
  webhook: WebhookInfo,
  key: string,
): Promise<string | undefined> => {
  const known = webhook.threads?.find((thread) => thread.key === key);
  if (known === undefined) return undefined;
  // A chat the owner removed starts a new one.
  return (await profiles.rowOf(known.sessionId)) !== undefined ? known.sessionId : undefined;
};

/** Record a thread's chat (or that it was active), dropping the least recently active past the cap. */
const remember = (threads: readonly WebhookThread[], next: WebhookThread): WebhookThread[] =>
  [...threads.filter((thread) => thread.key !== next.key), next]
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_WEBHOOK_THREADS);

/** One thread resolution at a time per webhook: two payloads of a new thread open ONE chat. */
const locks = new Map<string, Promise<unknown>>();

const serial = <A>(id: string, run: () => Promise<A>): Promise<A> => {
  const next = (locks.get(id) ?? Promise.resolve()).then(run, run);
  const settled = next.catch(() => undefined);
  locks.set(id, settled);
  void settled.then(() => {
    if (locks.get(id) === settled) locks.delete(id);
  });
  return next;
};

/**
 * The chat a thread continues: its known chat, else a new chat under the
 * webhook's bot, titled from the payload ("Login button broken"), else from
 * the webhook ("GitHub · 12"). Falls back to the webhook's own chat when no
 * chat can be opened (an archived bot).
 */
export const threadChat = (
  deps: {
    readonly converse: ConverseService;
    readonly profiles: Pick<ProfilesService, "rowOf" | "createSession">;
    readonly findWebhook: (id: string) => Promise<WebhookInfo | undefined>;
  },
  webhookId: string,
  thread: { readonly key: string; readonly title: string | null },
): Promise<string> =>
  serial(webhookId, async () => {
    const webhook = await deps.findWebhook(webhookId);
    if (webhook === undefined) throw new Error("unknown webhook");
    const owner = (await deps.profiles.rowOf(webhook.sessionId))?.owner;
    let sessionId = await knownThreadChat(deps.profiles, webhook, thread.key);
    if (sessionId === undefined) {
      if (owner === undefined) return webhook.sessionId;
      const title = thread.title ?? `${webhook.name ?? "Webhook"} · ${thread.key}`;
      try {
        sessionId = (await deps.profiles.createSession(owner, webhook.profile, title)).id;
      } catch (cause) {
        console.error(`webhook ${webhookId}: no chat for thread ${thread.key}:`, cause);
        return webhook.sessionId;
      }
    }
    const chat = sessionId;
    await updateWebhook(deps.converse, webhookId, (current) => ({
      ...current,
      threads: remember(current.threads ?? [], {
        key: thread.key,
        sessionId: chat,
        at: Date.now(),
      }),
    }));
    return chat;
  });
