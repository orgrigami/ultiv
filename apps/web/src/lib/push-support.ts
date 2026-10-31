/**
 * Can this browser get push notifications, and if not, why — in words the
 * owner can act on. Pure, so the decision is testable without a browser.
 */
import { BRAND } from "./brand.ts";

export type PushSupport = "ok" | "insecure" | "install-first" | "unsupported" | "blocked";

export interface PushEnv {
  readonly secure: boolean;
  readonly serviceWorker: boolean;
  readonly pushManager: boolean;
  readonly notification: boolean;
  readonly permission: NotificationPermission | null;
  /** iPhone/iPad Safari: push only works from a Home Screen app. */
  readonly ios: boolean;
  readonly standalone: boolean;
}

export const pushSupport = (env: PushEnv): PushSupport => {
  if (!env.secure) return "insecure";
  if (env.ios && !env.standalone) return "install-first";
  if (!env.serviceWorker || !env.pushManager || !env.notification) return "unsupported";
  if (env.permission === "denied") return "blocked";
  return "ok";
};

export const SUPPORT_TEXT: Record<Exclude<PushSupport, "ok">, string> = {
  insecure: `Notifications need the secure (https) address. Open ${BRAND.name} from your tailnet https link.`,
  "install-first": `On iPhone, add ${BRAND.name} to your Home Screen first (Share, then Add to Home Screen).`,
  unsupported: `This browser can't show notifications from ${BRAND.name}.`,
  blocked: "Notifications are blocked for this site. Allow them in your browser settings.",
};

/** The VAPID public key (base64url) as the bytes PushManager wants. */
export const keyBytes = (base64url: string): Uint8Array<ArrayBuffer> => {
  const padded = `${base64url}${"=".repeat((4 - (base64url.length % 4)) % 4)}`;
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
};
