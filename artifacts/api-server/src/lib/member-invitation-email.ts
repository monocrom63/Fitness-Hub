import { closureEmailReadiness, closureEmailSender } from "./closure-email";
import { resendRequest, type ResendRequest } from "./resend-client";

export type MemberInvitationEmail = {
  invitationId: number;
  memberName: string;
  memberEmail: string;
  inviteUrl: string;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

export async function sendMemberInvitationEmail(
  invitation: MemberInvitationEmail,
  options: { request?: ResendRequest; sender?: string } = {},
): Promise<{ sent: boolean; reason?: string }> {
  const request = options.request ?? resendRequest;
  const sender = options.sender ?? closureEmailSender();
  const readinessError = await closureEmailReadiness(request, sender);
  if (readinessError) return { sent: false, reason: readinessError };

  const name = escapeHtml(invitation.memberName);
  const url = escapeHtml(invitation.inviteUrl);
  const text = [
    `Hallo ${invitation.memberName},`,
    "",
    "dein Studio hat dich zu Fiudia eingeladen. Öffne den persönlichen Link, um dein Konto mit deiner Mitgliedschaft zu verbinden:",
    invitation.inviteUrl,
    "",
    "Der Link ist einmalig und sieben Tage gültig. Verwende dafür das Fiudia-Konto mit dieser E-Mail-Adresse.",
    "",
    "Dein Fiudia-Team",
  ].join("\n");
  const html = `<p>Hallo ${name},</p><p>dein Studio hat dich zu Fiudia eingeladen. Öffne den persönlichen Link, um dein Konto mit deiner Mitgliedschaft zu verbinden:</p><p><a href="${url}">Mitgliedschaft verbinden</a></p><p>Der Link ist einmalig und sieben Tage gültig. Verwende dafür das Fiudia-Konto mit dieser E-Mail-Adresse.</p><p>Dein Fiudia-Team</p>`;

  try {
    const response = await request("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `fiudia-member-invitation-${invitation.invitationId}`,
      },
      body: JSON.stringify({
        from: sender,
        to: [invitation.memberEmail],
        subject: "Dein Studio lädt dich zu Fiudia ein",
        text,
        html,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json().catch(() => ({})) as { id?: string; message?: string };
    if (!response.ok || !result.id) {
      return { sent: false, reason: result.message ?? `Resend returned HTTP ${response.status}.` };
    }
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : "Email delivery failed." };
  }
}
