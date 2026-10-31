/**
 * The webhook row's two server actions. Each re-reads the Routines list once
 * the server has answered (`onChanged`), so counts are current without a page
 * reload. Kept free of UI imports so the root test suite can run it.
 */
import type { api } from "./api.ts";

export type WebhookApi = Pick<typeof api, "testWebhook" | "rotateWebhookToken">;

/** Send a test payload and say what happened. */
export async function sendTest(
  client: WebhookApi,
  id: string,
  payload: string,
  onChanged: () => Promise<void>,
): Promise<string> {
  let result: string;
  try {
    const outcome = await client.testWebhook(id, JSON.parse(payload) as unknown);
    result = outcome.accepted
      ? "Accepted: the payload matches."
      : `Turned away: ${outcome.detail ?? "the payload doesn't match the expected format"}`;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  await onChanged();
  return result;
}

/** Issue a new token (shown once by the caller), then re-read the list. */
export async function issueToken(
  client: WebhookApi,
  id: string,
  onChanged: () => Promise<void>,
): Promise<string | null> {
  const rotated = await client.rotateWebhookToken(id);
  await onChanged();
  return rotated.token ?? null;
}
