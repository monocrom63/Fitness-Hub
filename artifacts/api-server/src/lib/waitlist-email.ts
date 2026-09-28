export const WAITLIST_EMAIL_SENDER = "mail@fiudia.com";

export type WaitlistEmailDraft = {
  from: string;
  to: string;
  subject: string;
  text: string;
};

export function promotionNotice(title: string, startsAt: Date) {
  const date = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(startsAt);
  return {
    title: "Dein Kursplatz ist bestätigt",
    body: `Du bist für „${title}“ am ${date} Uhr von der Warteliste nachgerückt. Deinen Platz findest du unter „Meine Plätze“.`,
  };
}

// Builds the plain-text content snapshotted in the outbox; this function does not send.
export function waitlistEmailDraft(recipient: string, notice: ReturnType<typeof promotionNotice>): WaitlistEmailDraft {
  return {
    from: WAITLIST_EMAIL_SENDER,
    to: recipient,
    subject: `Fiudia: ${notice.title}`,
    text: `${notice.body}\n\nDein Fiudia-Team`,
  };
}