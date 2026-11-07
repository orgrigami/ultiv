/**
 * The Routines slice of the REST client (spread into `api`): schedules with
 * their trials, webhooks, sensors and the shared receipt log.
 */
import type { CronJobInfo, RoutineEvent, SensorInfo, WebhookInfo } from "@spriessen/contracts";
import { getJson, send } from "./api.ts";

export const routinesApi = {
  cron: (): Promise<CronJobInfo[]> => getJson<CronJobInfo[]>("/api/cron"),
  removeCron: (id: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(`/api/cron/${encodeURIComponent(id)}`, "DELETE"),
  /** Pause/resume a schedule, or turn its trial mode on or off ("Go live"). */
  patchCron: (id: string, patch: { enabled?: boolean; trial?: boolean }): Promise<CronJobInfo> =>
    send<CronJobInfo>(`/api/cron/${encodeURIComponent(id)}`, "PATCH", patch),
  /** Run one trial now; the result lands on the job (the `routines` signal). */
  tryCron: (id: string): Promise<{ started: boolean }> =>
    send<{ started: boolean }>(`/api/cron/${encodeURIComponent(id)}/try`, "POST"),
  webhooks: (): Promise<WebhookInfo[]> => getJson<WebhookInfo[]>("/api/webhooks"),
  createWebhook: (input: {
    sessionId: string;
    name?: string;
    schema?: Record<string, unknown> | null;
  }): Promise<WebhookInfo> => send<WebhookInfo>("/api/webhooks", "POST", input),
  removeWebhook: (id: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(`/api/webhooks/${encodeURIComponent(id)}`, "DELETE"),
  /** New token for a webhook; the response is the only place it appears. */
  rotateWebhookToken: (id: string): Promise<WebhookInfo> =>
    send<WebhookInfo>(`/api/webhooks/${encodeURIComponent(id)}/token`, "POST"),
  testWebhook: (id: string, payload: unknown): Promise<{ accepted: boolean; detail?: string }> =>
    send(`/api/webhooks/${encodeURIComponent(id)}/test`, "POST", { payload }),
  sensors: (): Promise<SensorInfo[]> => getJson<SensorInfo[]>("/api/sensors"),
  removeSensor: (id: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(`/api/sensors/${encodeURIComponent(id)}`, "DELETE"),
  routineEvents: (limit?: number): Promise<RoutineEvent[]> =>
    getJson<RoutineEvent[]>(`/api/routines/events?limit=${limit ?? 30}`),
};
