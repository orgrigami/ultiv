/**
 * The sign-in gate: the one door in front of the app. It asks the server for
 * the auth status once, then either renders the app (a live session), the
 * sign-in form, the one-time set-passcode form (on the host only), or the
 * "set it on the host first" note for other devices. Any API 401 re-opens
 * the gate.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  UNAUTHORIZED_EVENT,
  authStatus,
  setPasscode,
  signIn,
  signInWithPasskey,
  type AuthStatus,
} from "@/lib/auth";
import { BRAND } from "@/lib/brand";

/** Sign-in / setup form: passcode in, one button, one error line. */
function PasscodeForm({
  mode,
  passkeysAvailable,
  onDone,
}: {
  mode: "sign-in" | "setup";
  passkeysAvailable: boolean;
  onDone: () => void;
}) {
  const [passcode, setPasscodeValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (passcode === "" || busy) return;
    setBusy(true);
    setError(null);
    const result: { ok: boolean; error: string | null } =
      mode === "setup" ? await setPasscode(passcode) : await signIn(passcode);
    setBusy(false);
    if (result.ok) {
      setPasscodeValue("");
      onDone();
    } else {
      setError(result.error ?? "That didn't work.");
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex w-64 flex-col gap-3">
      <label className="text-sm" htmlFor="passcode">
        {mode === "setup" ? "Choose a passcode" : "Passcode"}
      </label>
      <Input
        id="passcode"
        type="password"
        value={passcode}
        onChange={(event) => setPasscodeValue(event.target.value)}
        autoFocus
        autoComplete={mode === "setup" ? "new-password" : "current-password"}
      />
      {error !== null && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <Button type="submit" disabled={passcode === "" || busy}>
        {busy && <Spinner />}
        {mode === "setup" ? "Save passcode" : "Sign in"}
      </Button>
      {mode === "setup" && (
        <p className="text-muted-foreground text-xs">
          This passcode is the sign-in for this server, on every device. Keep it in your password
          manager; if it's lost, recovery runs on the host.
        </p>
      )}
      {mode === "sign-in" && passkeysAvailable && <PasskeyButton onDone={onDone} />}
    </form>
  );
}

/** Sign in with a passkey instead of the passcode. */
function PasskeyButton({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void signInWithPasskey().then((result) => {
            setBusy(false);
            if (result.ok) onDone();
            else setError(result.error ?? "That didn't work.");
          });
        }}
      >
        Use a passkey
      </Button>
      {error !== null && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

/** The gate around the whole app: status, then app or one of the forms. */
export function SignInGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const recheck = useCallback(async (): Promise<void> => {
    try {
      setStatus(await authStatus());
      setFailed(false);
    } catch {
      // The server is down or unreachable; say so and let a retry happen.
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void recheck();
    const onUnauthorized = (): void => void recheck();
    const onFocus = (): void => void recheck();
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
      window.removeEventListener("focus", onFocus);
    };
  }, [recheck]);

  if (failed) {
    return (
      <Centered>
        <p className="text-sm">The server isn't reachable right now.</p>
        <Button variant="outline" onClick={() => void recheck()}>
          Try again
        </Button>
      </Centered>
    );
  }
  if (status === null) {
    return (
      <Centered>
        <Spinner />
      </Centered>
    );
  }
  if (status.session) return <>{children}</>;
  const mode = status.passcodeSet ? "sign-in" : status.bootstrap ? "setup" : null;
  return (
    <Centered>
      <div className="flex flex-col items-start gap-4">
        <span className="text-title">{BRAND.name}</span>
        {mode !== null ? (
          <PasscodeForm
            mode={mode}
            passkeysAvailable={status.passkeys}
            onDone={() => void recheck()}
          />
        ) : (
          <p className="text-muted-foreground max-w-72 text-sm">
            This server needs its passcode set first. Open it on the host itself (localhost) to
            choose one, then sign in here.
          </p>
        )}
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center gap-4">{children}</div>
  );
}
