/**
 * The attention last-mile: escalations must ARRIVE, not just be recorded.
 * Wired to the audit faculty's escalation hook; delivers by email through
 * Resend when RESEND_API_KEY + EMAIL_FROM + ESCALATION_EMAIL are configured,
 * and always logs loudly. Notifications are coalesced (one per
 * kind+subject per hour) so a flapping routine cannot spam the owner.
 */
import type { MindService } from "@spreissen/mind";
import type { AuditEvent } from "@spreissen/contracts";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
/** One notification per kind+subject per hour — flapping must not spam. */
const RATE_LIMIT_MS = 60 * 60 * 1000;

const lastSent = new Map<string, number>();

const escalationConfigured = (): boolean =>
  process.env.RESEND_API_KEY !== undefined &&
  process.env.RESEND_API_KEY?.trim() !== "" &&
  process.env.EMAIL_FROM?.trim() !== "" &&
  process.env.EMAIL_FROM !== undefined &&
  process.env.ESCALATION_EMAIL?.trim() !== "" &&
  process.env.ESCALATION_EMAIL !== undefined;

const sendEmail = async (event: AuditEvent): Promise<void> => {
  const subject = `[spreissen] ${event.name}${event.profile !== null ? ` (${event.profile})` : ""}`;
  const body = [
    `A Routine escalation fired at ${new Date(event.at).toISOString()}.`,
    "",
    `name:    ${event.name}`,
    `profile: ${event.profile ?? "—"}`,
    `subject: ${event.callId}`,
    `error:   ${event.error ?? "—"}`,
    "",
    "The receipt log has the details: GET /api/routines/events",
  ].join("\n");
  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY ?? ""}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [process.env.ESCALATION_EMAIL],
      subject,
      text: body,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`resend returned ${response.status}`);
};

/** Wire the pager to the mind's audit escalations. */
export const wireEscalationPager = (mind: MindService): void => {
  mind.audit.setHooks({
    onEscalation: (event) => {
      const detail = String(event.error ?? "").slice(0, 200);
      console.error(`ESCALATION ${event.name} (${event.callId}): ${detail}`);
      if (!escalationConfigured()) return;
      const key = `${event.name}:${event.callId}`;
      const previous = lastSent.get(key) ?? 0;
      if (Date.now() - previous < RATE_LIMIT_MS) {
        console.error(`escalation notification for ${key} rate-limited (already sent recently)`);
        return;
      }
      lastSent.set(key, Date.now());
      void sendEmail(event).catch((cause) => {
        console.error(
          `escalation email failed (${String(cause).slice(0, 200)}) — check RESEND_API_KEY/EMAIL_FROM/ESCALATION_EMAIL`,
        );
      });
    },
  });
};
