/**
 * Push wiring: VAPID config, the subscription store, presence, the notifier
 * (sending through web-push) and the mind event subscriptions. Without
 * VAPID keys the routes still answer, `configured` is false and nothing is
 * ever sent.
 */
import webpush from "web-push";
import type { MindService } from "@spreissen/mind";
import { onRoutineReply } from "../deliver.ts";
import { pushDir, vapidConfig, type VapidConfig } from "./config.ts";
import { pushRoutineReply, wirePushEvents } from "./events.ts";
import { makeNotifier, type Notifier, type PushSend } from "./notifier.ts";
import { makePresence, type Presence } from "./presence.ts";
import { makePushStore, type PushStore } from "./store.ts";

export interface PushService {
  readonly config: VapidConfig | null;
  readonly store: PushStore;
  readonly presence: Presence;
  readonly notifier: Notifier;
  readonly stop: () => void;
}

const webPushSend =
  (config: VapidConfig): PushSend =>
  async (subscription, body, options) =>
    webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, body, {
      vapidDetails: config,
      TTL: options.TTL,
      topic: options.topic,
      urgency: options.urgency,
      timeout: 10_000,
    });

export const startPush = (mind: MindService, env: NodeJS.ProcessEnv = process.env): PushService => {
  const config = vapidConfig(env);
  const store = makePushStore(pushDir(env));
  const presence = makePresence();
  const send: PushSend = config !== null ? webPushSend(config) : async () => ({ statusCode: 0 }); // unconfigured: inert
  const notifier = makeNotifier({ store, presence, send });
  if (config === null) {
    return { config, store, presence, notifier, stop: () => undefined };
  }
  const unwire = wirePushEvents(mind, notifier);
  const unroutine = onRoutineReply((sessionId, source) => {
    void pushRoutineReply(mind, notifier, sessionId, source).catch((cause) =>
      console.error("push (routine) failed:", String(cause).slice(0, 200)),
    );
  });
  return {
    config,
    store,
    presence,
    notifier,
    stop: () => {
      unwire();
      unroutine();
    },
  };
};
