/**
 * The notifications setting: turn push on or off for THIS device, and send
 * a test. Explains, in plain words, why it can't be turned on here (not
 * https, iPhone not installed, blocked, server not set up).
 */
import { BRAND } from "@/lib/brand";
import { BellIcon, BellOffIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui/section-header";
import { api, type PushConfig } from "@/lib/api";
import { notifyError } from "@/lib/notify";
import { currentSubscription, currentSupport, disablePush, enablePush } from "@/lib/push";
import { SUPPORT_TEXT } from "@/lib/push-support";
import { toast } from "sonner";

const TEST_TEXT: Record<string, string> = {
  sent: "Test sent. It should arrive in a few seconds.",
  duplicate: "A test just went out. Wait a moment before sending another.",
  "rate-limited": "Too many notifications this minute. Try again shortly.",
  "no-devices": "No device is subscribed yet.",
};

function useDeviceState() {
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const [next, subscription] = await Promise.all([api.pushConfig(), currentSubscription()]);
      setConfig(next);
      setOn(subscription !== null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => void reload(), [reload]);
  return { config, on, error, reload };
}

export function PushToggle() {
  const { config, on, error, reload } = useDeviceState();
  const [busy, setBusy] = useState(false);
  const support = currentSupport();
  const act = async (what: () => Promise<void>, failure: string): Promise<void> => {
    setBusy(true);
    try {
      await what();
    } catch (cause) {
      notifyError(failure, cause);
    } finally {
      setBusy(false);
      await reload();
    }
  };
  const blocker =
    error ??
    (support !== "ok"
      ? SUPPORT_TEXT[support]
      : config !== null && !config.configured
        ? "Notifications aren't set up on the server yet."
        : null);
  return (
    <section aria-label="Notifications" className="flex flex-col gap-2">
      <SectionHeader title="Notifications" />
      <div className="flex flex-col gap-3 rounded-[14px] border p-3 text-sm">
        <p className="text-muted-foreground">
          Get a notification on this device when a task finishes or fails, a bot needs your
          approval, a routine gets a reply, or a message between bots times out. Nothing is sent
          while {BRAND.name} is open on screen.
        </p>
        {blocker !== null ? (
          <p className="text-muted-foreground">{blocker}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              variant={on ? "outline" : "default"}
              disabled={busy || config === null}
              onClick={() =>
                void act(
                  () => (on ? disablePush() : enablePush(config?.publicKey ?? "")),
                  on ? "Couldn't turn notifications off" : "Couldn't turn notifications on",
                )
              }
            >
              {on ? <BellOffIcon /> : <BellIcon />}
              {on ? "Turn off on this device" : "Turn on for this device"}
            </Button>
            {on && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const { outcome } = await api.pushTest();
                    toast(TEST_TEXT[outcome] ?? "Test sent.");
                  }, "Couldn't send a test")
                }
              >
                Send a test
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
