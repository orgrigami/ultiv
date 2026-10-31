/**
 * Web Push (VAPID) configuration from the environment. The keys are written
 * once into .env by `vpr @spreissen/server#push:keys` and never logged. Without
 * them push is simply off: the routes report `configured: false`.
 */
export interface VapidConfig {
  readonly publicKey: string;
  readonly privateKey: string;
  /** A `mailto:` or `https:` contact the push services may use (Safari requires one). */
  readonly subject: string;
}

const DEFAULT_SUBJECT = "mailto:owner@example.com";

export const vapidConfig = (env: NodeJS.ProcessEnv = process.env): VapidConfig | null => {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? "";
  if (publicKey === "" || privateKey === "") return null;
  const subject = env.VAPID_SUBJECT?.trim() ?? "";
  const valid = subject.startsWith("mailto:") || subject.startsWith("https://");
  return { publicKey, privateKey, subject: valid ? subject : DEFAULT_SUBJECT };
};

/** Where subscriptions live (one JSON file, owner-keyed, mode 0600). */
export const pushDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const configured = env.PUSH_DIR?.trim();
  return configured !== undefined && configured !== "" ? configured : "var/push";
};
