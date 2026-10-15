import { closureEmailReadiness, closureEmailSender } from "./closure-email";
import { renderFiudiaEmail } from "./fiudia-email";
import { resendRequest, type ResendRequest } from "./resend-client";

export type MemberInvitationEmail = {
  invitationId: number;
  attempt?: number;
  memberName: string;
  memberEmail: string;
  inviteUrl: string;
};

export async function sendMemberInvitationEmail(
  invitation: MemberInvitationEmail,
  options: { request?: ResendRequest; sender?: string } = {},
): Promise<{ sent: boolean; providerId?: string; reason?: string }> {
  const request = options.request ?? resendRequest;
  const sender = options.sender ?? closureEmailSender();
  const readinessError = await closureEmailReadiness(request, sender);
  if (readinessError) return { sent: false, reason: readinessError };

  const email = renderFiudiaEmail({
    title: "Dein Studio lädt dich zu Fiudia ein",
    paragraphs: [
      `Hallo ${invitation.memberName},`,
      "dein Studio hat dich eingeladen. Verbinde dein Konto mit deiner Mitgliedschaft über den persönlichen Link.",
      "Der Link ist einmalig und sieben Tage gültig. Verwende dafür das Fiudia-Konto mit dieser E-Mail-Adresse.",
    ],
    action: { label: "Mitgliedschaft verbinden", url: invitation.inviteUrl },
  });

  try {
    const response = await request("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `fiudia-member-invitation-${invitation.invitationId}-attempt-${invitation.attempt ?? 1}`,
      },
      body: JSON.stringify({
        from: sender,
        to: [invitation.memberEmail],
        subject: "Fiudia | Einladung von deinem Studio",
        ...email,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json().catch(() => ({})) as { id?: string; message?: string };
    if (!response.ok || !result.id) {
      return { sent: false, reason: result.message ?? `Resend returned HTTP ${response.status}.` };
    }
    return { sent: true, providerId: result.id };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : "Email delivery failed." };
  }
}
