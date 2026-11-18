import { useMemo, useRef, useState } from "react";
import { useCreateMarketingCheckout, useGetMarketingSubscription, useListOneSignalMarketingRecipients, useSendOneSignalMarketingMessage, getListOneSignalMarketingRecipientsQueryKey } from "@workspace/api-client-react";
import type { OneSignalMarketingMessageInput, OneSignalMarketingMessageResult, OneSignalMarketingRecipient, Role } from "@workspace/api-client-react";
import { Check, Megaphone, RefreshCw, Send, ShieldCheck, Users } from "lucide-react";

type Channel = OneSignalMarketingMessageInput["channel"];
type AttemptKeys = { fingerprint: string; sms: string; push: string };

function errorMessage(error: unknown) {
  const apiError = error as { data?: { error?: string }; message?: string } | null;
  return apiError?.data?.error || apiError?.message || "Die Nachricht konnte nicht gesendet werden.";
}

function canReceive(member: OneSignalMarketingRecipient, channel: Channel) {
  if (channel === "sms") return member.smsEligible;
  if (channel === "push") return member.pushSubscriptionCount > 0;
  return member.smsEligible || member.pushSubscriptionCount > 0;
}

function resultSummary(result: OneSignalMarketingMessageResult) {
  const pieces: string[] = [];
  if (result.smsMessageId) pieces.push(`${result.smsTargetCount} SMS an OneSignal übergeben`);
  if (result.pushMessageId) pieces.push(`${result.pushTargetCount} Push-Zustellungen an OneSignal übergeben`);
  if (result.skippedSmsCount) pieces.push(`${result.skippedSmsCount} ohne gültige Telefonnummer übersprungen`);
  if (result.skippedPushCount) pieces.push(`${result.skippedPushCount} ohne registriertes Push-Gerät übersprungen`);
  if (result.smsError) pieces.push(`SMS: ${result.smsError}`);
  if (result.pushError) pieces.push(`Push: ${result.pushError}`);
  return pieces.join(" · ");
}

export default function MemberOneSignalForm({ role }: { role: Role }) {
  const recipients = useListOneSignalMarketingRecipients({
    query: {
      queryKey: getListOneSignalMarketingRecipientsQueryKey(),
      staleTime: 30_000,
    },
  });
  const subscription = useGetMarketingSubscription();
  const checkout = useCreateMarketingCheckout();
  const send = useSendOneSignalMarketingMessage();
  const [channel, setChannel] = useState<Channel>("sms");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const attemptKeys = useRef<AttemptKeys | null>(null);
  const allRecipients = recipients.data ?? [];
  const eligible = useMemo(
    () => allRecipients.filter(member => canReceive(member, channel)),
    [allRecipients, channel],
  );
  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("de-DE");
    return eligible.filter(member =>
      !query || member.fullName.toLocaleLowerCase("de-DE").includes(query) || (member.phone ?? "").includes(query),
    );
  }, [eligible, search]);
  const selected = eligible.filter(member => selectedIds.includes(member.id));
  const activeSubscription = subscription.data?.active === true && subscription.data.status !== "test_access";

  function changeChannel(next: Channel) {
    setChannel(next);
    setSelectedIds(current => current.filter(id => {
      const member = allRecipients.find(item => item.id === id);
      return !!member && canReceive(member, next);
    }));
    setNotice("");
    setError("");
  }

  function toggleRecipient(memberId: number) {
    setSelectedIds(current => current.includes(memberId)
      ? current.filter(id => id !== memberId)
      : [...current, memberId]);
    setNotice("");
    setError("");
  }

  function toggleAll() {
    const visibleIds = visible.map(member => member.id);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedIds.includes(id));
    setSelectedIds(current => allVisibleSelected
      ? current.filter(id => !visibleIds.includes(id))
      : [...new Set([...current, ...visibleIds])]);
    setNotice("");
    setError("");
  }

  function beginCheckout() {
    if (role !== "district_manager") {
      setError("Für den Versand muss die Bezirksleitung das Marketing-Abo freischalten.");
      return;
    }
    if (!window.confirm("Der Versand benötigt ein Marketing-Abo für 99 € pro Monat und Organisation. Der Entwurf wird nicht automatisch gesendet. Jetzt zum Checkout?")) return;
    checkout.mutate(undefined, {
      onSuccess: result => { window.location.assign(result.url); },
      onError: err => setError(errorMessage(err)),
    });
  }

  function sendMessage() {
    setError("");
    setNotice("");
    if (subscription.isError) {
      setError("Marketingstatus konnte nicht geprüft werden. Bitte aktualisieren und erneut versuchen.");
      return;
    }
    if (!activeSubscription) {
      beginCheckout();
      return;
    }
    if (!selected.length || !message.trim()) return;
    const fingerprint = JSON.stringify({
      ids: selected.map(member => member.id).sort((a, b) => a - b),
      channel,
      message: message.trim(),
    });
    if (attemptKeys.current?.fingerprint !== fingerprint) {
      attemptKeys.current = {
        fingerprint,
        sms: crypto.randomUUID(),
        push: crypto.randomUUID(),
      };
    }
    const keys = attemptKeys.current;
    const channelLabel = channel === "both" ? "SMS und Push" : channel === "sms" ? "SMS" : "Push";
    if (!window.confirm(`${channelLabel} jetzt an ${selected.length} ausgewählte Mitglieder senden?\n\nEs werden nur Mitglieder mit dokumentierter Marketing-Einwilligung berücksichtigt. Dieser Versand kann nach Annahme durch OneSignal nicht zurückgerufen werden.`)) return;
    send.mutate({
      data: {
        memberIds: selected.map(member => member.id),
        channel,
        message: message.trim(),
        smsIdempotencyKey: keys.sms,
        pushIdempotencyKey: keys.push,
      },
    }, {
      onSuccess: result => {
        setNotice(resultSummary(result) || "OneSignal hat die Anfrage angenommen.");
        if (result.status === "sent") attemptKeys.current = null;
        void recipients.refetch();
      },
      onError: err => setError(errorMessage(err)),
    });
  }

  return <section className="onesignal-composer" aria-labelledby="onesignal-composer-title" data-testid="panel-onesignal-message">
    <header className="onesignal-composer-heading">
      <div className="onesignal-composer-icon"><Megaphone size={19} /></div>
      <div>
        <div className="eyebrow">Kundenverwaltung / OneSignal</div>
        <h2 id="onesignal-composer-title">Nachricht an Mitglieder</h2>
        <p>Es erscheinen nur aktive Mitglieder mit dokumentierter Marketing-Einwilligung.</p>
      </div>
      <button type="button" className="button button-outline onesignal-refresh" onClick={() => void recipients.refetch()} disabled={recipients.isFetching} data-testid="button-refresh-onesignal-recipients">
        <RefreshCw size={14} /> Aktualisieren
      </button>
    </header>

    <div className="onesignal-composer-grid">
      <div className="onesignal-compose-fields">
        <label className="field">
          <span>Versandkanal</span>
          <select value={channel} onChange={event => changeChannel(event.target.value as Channel)} data-testid="select-onesignal-channel">
            <option value="sms">SMS an Telefonnummern</option>
            <option value="push">Push an registrierte Geräte</option>
            <option value="both">SMS und Push</option>
          </select>
        </label>
        <label className="field">
          <span>Nachricht</span>
          <textarea value={message} onChange={event => { setMessage(event.target.value); setNotice(""); setError(""); }} rows={7} maxLength={1600} placeholder="Deine Nachricht an die ausgewählten Mitglieder …" data-testid="input-onesignal-message" />
          <small className="onesignal-char-count">{message.length} / 1.600 Zeichen · lange SMS können mehrere SMS-Segmente kosten</small>
        </label>
        <details className="onesignal-preview">
          <summary>Vorschau der Nachricht</summary>
          <div className="onesignal-preview-card">
            <small>{channel === "both" ? "SMS + Push" : channel === "sms" ? "SMS" : "Push"} · Beispielansicht</small>
            <p>{message.trim() || "Deine Nachricht erscheint hier."}</p>
          </div>
        </details>
        <p className="onesignal-consent-note"><ShieldCheck size={15} /> Der Server prüft die gespeicherte Marketing-Einwilligung erneut, bevor er versendet.</p>
      </div>

      <div className="onesignal-recipient-panel">
        <div className="onesignal-recipient-heading">
          <div><Users size={16} /><strong>Empfänger</strong></div>
          <span>{selected.length} ausgewählt · {eligible.length} erreichbar</span>
        </div>
        <div className="onesignal-recipient-actions">
          <button type="button" className="onesignal-text-button" onClick={toggleAll} disabled={!visible.length}>
            {visible.length > 0 && visible.every(member => selectedIds.includes(member.id)) ? "Sichtbare abwählen" : "Alle sichtbaren auswählen"}
          </button>
          <button type="button" className="onesignal-text-button" onClick={() => setSelectedIds([])} disabled={!selectedIds.length}>Auswahl leeren</button>
        </div>
        <input className="onesignal-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name oder Telefonnummer suchen" aria-label="Empfänger suchen" data-testid="input-onesignal-recipient-search" />
        {recipients.isLoading ? <p className="onesignal-list-state" role="status">Empfänger werden geladen …</p>
          : recipients.isError ? <div className="onesignal-list-error" role="alert">{errorMessage(recipients.error)}</div>
            : visible.length ? <ul className="onesignal-recipient-list">
              {visible.map(member => <li key={member.id}>
                <label>
                  <input type="checkbox" checked={selectedIds.includes(member.id)} onChange={() => toggleRecipient(member.id)} data-testid={`checkbox-onesignal-member-${member.id}`} />
                  <span><strong>{member.fullName}</strong><small>{member.phone || "Keine Telefonnummer"}</small></span>
                  <span className="onesignal-recipient-channels">
                    {member.smsEligible && <i>SMS</i>}
                    {member.pushSubscriptionCount > 0 && <i>Push</i>}
                  </span>
                </label>
              </li>)}
            </ul>
            : <p className="onesignal-list-state">{eligible.length ? "Keine passenden Namen gefunden." : "Keine aktiven, eingewilligten Empfänger für diesen Kanal."}</p>}
      </div>
    </div>

    {subscription.isError && <p className="onesignal-form-error" role="alert">Marketingstatus konnte nicht geprüft werden. Bitte erneut laden.</p>}
    {error && <p className="onesignal-form-error" role="alert" data-testid="error-onesignal-send">{error}</p>}
    {notice && <p className="onesignal-form-success" role="status" data-testid="status-onesignal-send"><Check size={15} /> {notice}</p>}
    <footer className="onesignal-composer-footer">
      <span>{channel === "both" ? "SMS und Push werden getrennt über OneSignal übergeben." : channel === "sms" ? "SMS nur an gültige internationale Telefonnummern." : "Push nur an registrierte OneSignal-Geräte."}</span>
      <button type="button" className="button button-dark" onClick={sendMessage} disabled={!selected.length || !message.trim() || recipients.isLoading || recipients.isError || send.isPending || checkout.isPending || subscription.isLoading || subscription.isError} data-testid="button-send-onesignal-message">
        <Send size={15} />{send.isPending ? "Wird gesendet …" : checkout.isPending ? "Checkout wird geöffnet …" : "Senden"}
      </button>
    </footer>
  </section>;
}
