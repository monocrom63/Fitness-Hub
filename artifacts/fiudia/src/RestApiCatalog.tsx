import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link } from 'wouter';
import {
  ArrowUpRight, Check, CircleHelp, Clock3, Copy, KeyRound, LockKeyhole,
  RotateCw, ShieldCheck, X,
} from 'lucide-react';
import {
  getGetMarketingApiKeyQueryKey, getListApiAccessRequestsQueryKey, getListApiCatalogQueryKey,
  useCreateApiAccessRequest, useGetMarketingApiKey, useGetMarketingSubscription, useListApiAccessRequests,
  useListApiCatalog, useReviewApiAccessRequest, useRotateMarketingApiKey,
} from '@workspace/api-client-react';
import type { ApiAccessRequest, ApiCatalogEntry, Role } from '@workspace/api-client-react';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';

type RequestFields = { reason: string };
type ReviewFields = { reviewNote: string };

const serviceNames: Record<ApiCatalogEntry['serviceKey'], string> = {
  marketing: 'Marketing',
  personio: 'Personio',
  access: 'Zutrittssystem',
  accounting: 'Buchhaltung',
};

function dateLabel(value: string | null) {
  if (!value) return 'Noch nicht verwendet';
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function StatusPill({ status, label, testId }: { status: string; label: string; testId: string }) {
  return <span className={`api-status api-status-${status}`} data-testid={testId}>{label}</span>;
}

function CatalogSkeleton() {
  return <div className="api-catalog-skeleton" role="status" aria-label="API-Katalog wird geladen" data-testid="status-api-loading">
    <div /><div /><div />
  </div>;
}

function RequestReview({ request, onReview, busy }: {
  request: ApiAccessRequest;
  onReview: (request: ApiAccessRequest, decision: 'approve' | 'reject', note: string) => void;
  busy: boolean;
}) {
  const form = useForm<ReviewFields>({ defaultValues: { reviewNote: '' } });
  const review = (decision: 'approve' | 'reject') => form.handleSubmit(({ reviewNote }) => onReview(request, decision, reviewNote.trim()))();
  return <article className="api-request-row" data-testid={`row-api-request-${request.id}`}>
    <div className="api-request-person"><span className="api-request-avatar">{request.requestedBy.split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase()}</span>
      <div><strong>{request.requestedBy}</strong><small>{request.requestedByEmail} · {dateLabel(request.createdAt)}</small></div>
    </div>
    <p className="api-request-reason">{request.reason}</p>
    <Form {...form}>
      <FormField control={form.control} name="reviewNote" render={({ field }) => <FormItem className="api-review-field">
        <FormLabel>Notiz (optional)</FormLabel><FormControl><input {...field} maxLength={500} placeholder="Kurze Rückmeldung" data-testid={`input-api-review-note-${request.id}`} /></FormControl><FormMessage />
      </FormItem>} />
    </Form>
    <div className="api-review-actions">
      <button type="button" className="button button-dark" onClick={() => void review('approve')} disabled={busy} data-testid={`button-api-approve-${request.id}`}><Check size={15} />Freigeben</button>
      <button type="button" className="button button-outline api-reject-button" onClick={() => void review('reject')} disabled={busy} data-testid={`button-api-reject-${request.id}`}><X size={15} />Ablehnen</button>
    </div>
  </article>;
}

export default function RestApiCatalog({ role }: { role: Role }) {
  const client = useQueryClient();
  const catalog = useListApiCatalog();
  const requests = useListApiAccessRequests();
  const key = useGetMarketingApiKey();
  const subscription = useGetMarketingSubscription();
  const createRequest = useCreateApiAccessRequest();
  const reviewRequest = useReviewApiAccessRequest();
  const rotateKey = useRotateMarketingApiKey();
  const form = useForm<RequestFields>({ defaultValues: { reason: '' } });
  const [oneTimeKey, setOneTimeKey] = useState('');
  const [copyFeedback, setCopyFeedback] = useState('');
  const [feedback, setFeedback] = useState('');
  const isDistrictManager = role === 'district_manager';

  const refreshCatalog = () => {
    void client.invalidateQueries({ queryKey: getListApiCatalogQueryKey() });
    void client.invalidateQueries({ queryKey: getListApiAccessRequestsQueryKey() });
    void client.invalidateQueries({ queryKey: getGetMarketingApiKeyQueryKey() });
  };

  const submitRequest = form.handleSubmit(({ reason }) => {
    setFeedback('');
    createRequest.mutate({ data: { serviceKey: 'marketing', reason: reason.trim() } }, {
      onSuccess: () => {
        refreshCatalog();
        form.reset({ reason: '' });
        setFeedback('Deine Anfrage wurde an die Bezirksleitung gesendet.');
      },
    });
  });

  const review = (request: ApiAccessRequest, decision: 'approve' | 'reject', reviewNote: string) => {
    reviewRequest.mutate({ id: request.id, data: { decision, ...(reviewNote ? { reviewNote } : {}) } }, {
      onSuccess: () => {
        refreshCatalog();
        setFeedback(decision === 'approve' ? 'Zugriff wurde freigegeben.' : 'Anfrage wurde abgelehnt.');
      },
    });
  };

  const rotate = () => {
    if (key.data?.active && !window.confirm('Den vorhandenen Marketing-Schlüssel ersetzen? Der neue Schlüssel wird nur einmal angezeigt.')) return;
    setOneTimeKey('');
    setCopyFeedback('');
    rotateKey.mutate(undefined, {
      onSuccess: result => {
        setOneTimeKey(result.key);
        setFeedback('Neuer Schlüssel erstellt. Bitte sicher speichern.');
        refreshCatalog();
      },
    });
  };

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(oneTimeKey);
      setCopyFeedback('Schlüssel kopiert.');
    } catch {
      setCopyFeedback('Kopieren nicht möglich. Bitte Schlüssel markieren und kopieren.');
    }
  };

  const retry = () => {
    void catalog.refetch();
    void requests.refetch();
    void key.refetch();
    void subscription.refetch();
  };

  if (catalog.isLoading || requests.isLoading) return <main className="api-catalog-page"><CatalogSkeleton /></main>;
  if (catalog.isError || requests.isError || !catalog.data || !requests.data) return <main className="api-catalog-page">
    <div className="api-catalog-error" role="alert" data-testid="status-api-error"><CircleHelp size={22} /><div><strong>API-Katalog nicht verfügbar</strong><p>Die Integrationen konnten gerade nicht geladen werden.</p></div><button className="button button-outline" onClick={retry} data-testid="button-api-retry">Erneut versuchen</button></div>
  </main>;

  const marketing = catalog.data.find(entry => entry.serviceKey === 'marketing');
  const planned = catalog.data.filter(entry => entry.serviceKey !== 'marketing');
  const pendingRequests = requests.data.filter(request => request.status === 'pending');
  const marketingRequest = requests.data.find(request => request.serviceKey === 'marketing');
  const canRequest = marketing?.availability === 'available' && marketing.accessStatus !== 'pending' && marketing.accessStatus !== 'approved';
  const canManageKey = marketing?.availability === 'available' && marketing.accessStatus === 'approved' && subscription.data?.active === true;
  const needsMarketingSubscription = marketing?.accessStatus === 'approved' && subscription.data?.active !== true;
  const docsUrl = marketing?.docsPath
    ? `${window.location.origin}${marketing.docsPath.startsWith('/') ? '' : '/'}${marketing.docsPath}`
    : null;

  return <main className="api-catalog-page">
    <header className="api-catalog-heading">
      <div>
        <div className="eyebrow">Fiudia / Einstellungen / Schnittstellen</div>
        <h1>API-Zugänge</h1>
        <p>Verwalte sichere Verbindungen zu den Systemen deiner Organisation.</p>
      </div>
      <div className="api-trust-note"><ShieldCheck size={17} /><span>Zugriffe werden von der Bezirksleitung freigegeben.</span></div>
    </header>

    <section className="api-intro-panel" aria-label="Über den API-Katalog">
      <div className="api-intro-symbol"><KeyRound size={22} /></div>
      <div><span className="eyebrow">Verbindungen im Überblick</span><h2>Ein klarer Zugang. Mit Verantwortung.</h2><p>Hier findest du verfügbare Fiudia-Schnittstellen und den Stand geplanter Anbindungen. Schlüssel werden erst nach einer Freigabe aktiviert.</p></div>
      <div className="api-intro-count"><strong>{catalog.data.length.toString().padStart(2, '0')}</strong><span>Integrationen</span></div>
    </section>

    <div className="api-catalog-layout">
      <section className="api-services" aria-labelledby="api-services-title">
        <div className="api-section-title"><div><div className="eyebrow">Katalog</div><h2 id="api-services-title">Verfügbare Integrationen</h2></div><span className="api-count-label">{catalog.data.length} Einträge</span></div>

        {marketing && <article className="api-service-card api-service-live" data-testid="card-api-service-marketing">
          <div className="api-service-topline"><span className="api-service-icon"><KeyRound size={19} /></span><StatusPill status="available" label="Verfügbar" testId="status-api-available-marketing" /><span className="api-service-type">Fiudia Schnittstelle</span></div>
          <div className="api-service-heading"><div><h3>{marketing.title}</h3><p>{marketing.description}</p></div><span className="api-service-index">01</span></div>

          {marketing.accessStatus === 'pending' && <div className="api-access-callout pending" data-testid="status-api-pending"><Clock3 size={17} /><div><strong>Anfrage wartet auf Freigabe</strong><span>Die Bezirksleitung prüft den Zugriff. Ein Schlüssel kann erst nach der Freigabe erstellt werden.</span></div></div>}
          {marketing.accessStatus === 'rejected' && <div className="api-access-callout rejected" data-testid="status-api-rejected"><X size={17} /><div><strong>Zugriff nicht freigegeben</strong><span>{marketingRequest?.reviewNote || 'Du kannst mit einer ergänzten Begründung erneut anfragen.'}</span></div></div>}
          {marketing.accessStatus === 'approved' && <div className="api-access-callout approved" data-testid="status-api-approved"><Check size={17} /><div><strong>Zugriff freigegeben</strong><span>Die Bezirksleitung hat den Zugang bestätigt. Du kannst jetzt einen persönlichen API-Schlüssel erstellen.</span></div></div>}
          {needsMarketingSubscription && <div className="api-access-callout pending" data-testid="status-api-subscription-required"><LockKeyhole size={17} /><div><strong>Marketing-Abo benötigt</strong><span>Der freigegebene API-Zugang wird mit dem aktiven Marketing-Modul nutzbar.</span><Link href="/marketing" data-testid="link-api-marketing-subscription">Zum Marketing-Abo <ArrowUpRight size={13} /></Link></div></div>}

          {canRequest && <div className="api-request-box">
            <div><strong>{marketing.accessStatus === 'rejected' ? 'Erneut Zugriff anfragen' : 'Zugriff beantragen'}</strong><span>Beschreibe kurz, wofür die Verbindung benötigt wird. Mindestens 10 Zeichen.</span></div>
            <Form {...form}>
              <form onSubmit={submitRequest} className="api-request-form" data-testid="form-api-access-request">
                <FormField control={form.control} name="reason" rules={{ required: 'Bitte gib einen Grund an.', validate: value => value.trim().length >= 10 || 'Bitte mindestens 10 Zeichen eingeben.', maxLength: { value: 2000, message: 'Maximal 2.000 Zeichen.' } }} render={({ field }) => <FormItem className="api-reason-field">
                  <FormLabel>Begründung</FormLabel><FormControl><textarea {...field} rows={3} maxLength={2000} placeholder="Zum Beispiel: Wir gleichen Kampagnenreichweiten mit unserem Planungssystem ab." data-testid="input-api-request-reason" /></FormControl><div className="api-reason-count">{field.value.length} / 2.000</div><FormMessage />
                </FormItem>} />
                <div className="api-request-submit">{createRequest.isError && <span className="api-inline-error" role="alert" data-testid="status-api-request-error">Anfrage konnte nicht gesendet werden. Bitte erneut versuchen.</span>}<button type="submit" className="button button-dark" disabled={createRequest.isPending} data-testid="button-api-request-access">{createRequest.isPending ? 'Wird gesendet …' : 'Zugriff anfragen'}<ArrowUpRight size={15} /></button></div>
              </form>
            </Form>
          </div>}

          {canManageKey && <div className="api-key-workspace">
            <div className="api-key-meta">
              <div className="api-key-meta-heading"><span className={`api-key-light ${key.data?.active ? 'is-active' : ''}`} /><div><strong>{key.isLoading ? 'Schlüsselstatus wird geladen …' : key.isError ? 'Schlüsselstatus nicht verfügbar' : key.data?.active ? `Schlüssel aktiv · ${key.data.keyPrefix || marketing.keyPrefix || 'Fiudia API'}` : 'Noch kein Schlüssel erstellt'}</strong><small>{key.data?.lastUsedAt || marketing.lastUsedAt ? `Zuletzt verwendet · ${dateLabel(key.data?.lastUsedAt || marketing.lastUsedAt)}` : 'Nur der Schlüsselinhaber kann den vollständigen Schlüssel sehen.'}</small></div></div>
              {key.isError && <button type="button" className="api-text-button" onClick={() => void key.refetch()} data-testid="button-api-retry-key">Status erneut laden</button>}
              <button type="button" className="button button-dark" onClick={rotate} disabled={rotateKey.isPending || key.isLoading || key.isError} data-testid="button-api-rotate-key"><RotateCw size={15} />{rotateKey.isPending ? 'Wird erstellt …' : key.data?.active ? 'Schlüssel erneuern' : 'Schlüssel erstellen'}</button>
            </div>
            {rotateKey.isError && <p className="api-inline-error" role="alert" data-testid="status-api-key-error">Schlüssel konnte nicht erstellt werden. Bitte erneut versuchen.</p>}
            {oneTimeKey && <div className="api-key-reveal" role="status" data-testid="status-api-key-created"><div><strong>Neuer Schlüssel · nur einmal sichtbar</strong><span>Speichere ihn sicher. Nach dem Verlassen dieser Seite ist er nicht mehr abrufbar.</span></div><code>{oneTimeKey}</code><button type="button" className="button button-outline" onClick={() => void copyKey()} data-testid="button-api-copy-key"><Copy size={15} />Kopieren</button>{copyFeedback && <small data-testid="status-api-copy-feedback">{copyFeedback}</small>}</div>}
          </div>}

          {marketing.availability === 'available' && <div className="api-docs-row">
            <div className="api-endpoint-details"><span>API-Endpunkt</span><code>/api/external/marketing/audience-count</code><small>Nur aggregierte Reichweiten — keine personenbezogenen Daten.</small></div>
            {docsUrl && <a className="api-doc-link" href={docsUrl} target="_blank" rel="noreferrer" data-testid="link-api-marketing-docs">Dokumentation öffnen <ArrowUpRight size={14} /></a>}
          </div>}
          {feedback && <div className="api-feedback" role="status" data-testid="status-api-feedback"><Check size={15} />{feedback}</div>}
        </article>}

        <div className="api-planned-heading"><span>In Vorbereitung</span><span>Geplant, noch nicht verfügbar</span></div>
        {planned.length ? <div className="api-planned-list">{planned.map((entry, index) => <PlannedService key={entry.serviceKey} entry={entry} index={index + 2} />)}</div> : <div className="api-empty" data-testid="status-api-empty"><span><LockKeyhole size={20} /></span><div><strong>Keine weiteren Einträge</strong><p>Neue Integrationen erscheinen hier, sobald sie verfügbar sind.</p></div></div>}
      </section>

      <aside className="api-aside">
        <section className="api-guardrail-card">
          <span className="api-aside-icon"><ShieldCheck size={18} /></span><div className="eyebrow">Sicher verbunden</div><h2>Freigabe vor Schlüssel.</h2><p>Jeder Marketing-Zugang wird zuerst von der Bezirksleitung geprüft. Schlüssel werden nur nach einer bestätigten Anfrage ausgestellt.</p>
          <div className="api-steps"><span><i>01</i><strong>Zugriff anfragen</strong></span><span><i>02</i><strong>Freigabe abwarten</strong></span><span><i>03</i><strong>Schlüssel erstellen</strong></span></div>
        </section>
        {isDistrictManager && <section className="api-review-card">
          <div className="api-review-heading"><div><div className="eyebrow">Für die Bezirksleitung</div><h2>Zugriffsanfragen</h2></div><span className="api-review-counter" data-testid="status-api-pending-count">{pendingRequests.length}</span></div>
          {pendingRequests.length ? <div className="api-request-list">{pendingRequests.map(request => <RequestReview request={request} key={request.id} onReview={review} busy={reviewRequest.isPending} />)}</div> : <div className="api-review-empty" data-testid="status-api-no-pending"><span><Check size={17} /></span><div><strong>Alles geprüft</strong><p>Aktuell warten keine API-Anfragen auf deine Freigabe.</p></div></div>}
          {reviewRequest.isError && <p className="api-inline-error" role="alert" data-testid="status-api-review-error">Die Entscheidung konnte nicht gespeichert werden.</p>}
        </section>}
        <section className="api-access-note"><LockKeyhole size={16} /><p><strong>Dein Schlüssel bleibt privat.</strong> Der vollständige Wert wird nach der Erstellung nicht erneut angezeigt.</p></section>
      </aside>
    </div>
  </main>;
}

function PlannedService({ entry, index }: { entry: ApiCatalogEntry; index: number }) {
  return <article className="api-planned-card" data-testid={`card-api-service-${entry.serviceKey}`}>
    <span className="api-planned-index">{String(index).padStart(2, '0')}</span><span className="api-planned-icon"><LockKeyhole size={17} /></span>
    <div className="api-planned-copy"><h3>{entry.title || serviceNames[entry.serviceKey]}</h3><p>{entry.description}</p></div>
    <StatusPill status="planned" label="Geplant" testId={`status-api-planned-${entry.serviceKey}`} />
    <span className="api-planned-lock">Noch kein Zugriff</span>
  </article>;
}
