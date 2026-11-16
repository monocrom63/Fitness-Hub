import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link } from 'wouter';
import {
  ArrowUpRight, CalendarClock, Check, ChevronRight, CircleHelp, Copy, ImagePlus, KeyRound,
  Mail, Megaphone, RotateCw, ShieldCheck, Users,
} from 'lucide-react';
import {
  getGetMarketingApiKeyQueryKey, getGetMarketingAudienceCountQueryKey, getListMarketingCampaignsQueryKey,
  useConfirmMarketingCheckout,
  useCreateMarketingBillingPortal, useCreateMarketingCampaign,
  useCreateMarketingCheckout, useGetMarketingApiKey, useGetMarketingAudienceCount,
  useGetMarketingSubscription, useListMarketingCampaigns, useListStudios,
  useListApiCatalog,
  useRequestMarketingImageUpload, useRotateMarketingApiKey, useSendMarketingCampaign,
} from '@workspace/api-client-react';
import type { MarketingCampaign, MarketingCampaignInput } from '@workspace/api-client-react';
import type { Role } from '@workspace/api-client-react';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';

type CampaignFields = {
  headline: string;
  bodyText: string;
  gender: 'all' | 'male' | 'female' | 'diverse';
  ageFrom: string;
  ageTo: string;
  city: string;
  studioId: string;
};

const emptyFields: CampaignFields = {
  headline: '', bodyText: '', gender: 'all', ageFrom: '', ageTo: '', city: '', studioId: '',
};

function errorMessage(error: unknown, fallback: string) {
  const apiError = error as { data?: { error?: string }; message?: string } | null;
  return apiError?.data?.error || apiError?.message || fallback;
}

function dateLabel(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(value));
}

function MarketingSkeleton() {
  return <div className="marketing-skeleton" role="status" aria-label="Marketingdaten werden geladen">
    <i /><i /><i />
  </div>;
}

function CampaignRow({ campaign, onSend, sending }: { campaign: MarketingCampaign; onSend: (campaign: MarketingCampaign, count: number, eligibleEmailCount: number) => void; sending: boolean }) {
  const params = {
    gender: campaign.audience.gender,
    ...(campaign.audience.ageFrom !== null ? { ageFrom: campaign.audience.ageFrom } : {}),
    ...(campaign.audience.ageTo !== null ? { ageTo: campaign.audience.ageTo } : {}),
    ...(campaign.audience.city ? { city: campaign.audience.city } : {}),
    ...(campaign.audience.studioId !== null ? { studioId: campaign.audience.studioId } : {}),
  };
  const counts = useGetMarketingAudienceCount(params, {
    query: {
      queryKey: getGetMarketingAudienceCountQueryKey(params),
      enabled: campaign.status === 'draft',
    },
  });
  return <article className="marketing-campaign-row" data-testid={`campaign-row-${campaign.id}`}>
    <div className="marketing-campaign-image">{campaign.imageUrl ? <img src={campaign.imageUrl} alt="" /> : <Megaphone size={19} />}</div>
    <div className="marketing-campaign-copy"><div className="marketing-campaign-meta"><span className={`marketing-state ${campaign.status}`}>{campaign.status === 'sent' ? 'Versendet' : 'Entwurf'}</span><span>{dateLabel(campaign.createdAt)}</span></div><h3>{campaign.headline}</h3><p>{campaign.bodyText}</p></div>
    <div className="marketing-campaign-results">
      {campaign.status === 'sent' ? <><strong>{campaign.recipientCount}</strong><span>Empfänger</span></> : counts.isLoading ? <><strong>…</strong><span>Reichweite wird geladen</span></> : counts.isError ? <><strong>—</strong><span>Reichweite nicht verfügbar</span></> : <><strong>{counts.data?.count ?? '—'}</strong><span>passende Mitglieder</span><small>{counts.data?.eligibleEmailCount ?? '—'} mit E-Mail</small></>}
    </div>
    {campaign.status === 'draft' && <button type="button" className="button button-outline marketing-send-button" onClick={() => onSend(campaign, counts.data?.count ?? 0, counts.data?.eligibleEmailCount ?? 0)} disabled={sending || counts.isLoading || counts.isError} data-testid={`button-send-marketing-${campaign.id}`}><Mail size={14} />{sending ? 'Wird gesendet …' : 'Senden'}</button>}
  </article>;
}

export default function MarketingPage({ role }: { role: Role }) {
  const client = useQueryClient();
  const subscription = useGetMarketingSubscription();
  const campaigns = useListMarketingCampaigns();
  const studios = useListStudios();
  const checkout = useCreateMarketingCheckout();
  const billingPortal = useCreateMarketingBillingPortal();
  const createCampaign = useCreateMarketingCampaign();
  const sendCampaign = useSendMarketingCampaign();
  const requestUpload = useRequestMarketingImageUpload();
  const apiKey = useGetMarketingApiKey();
  const rotateKey = useRotateMarketingApiKey();
  const apiCatalog = useListApiCatalog();
  const confirmCheckout = useConfirmMarketingCheckout();
  const form = useForm<CampaignFields>({ defaultValues: emptyFields });
  const [imagePath, setImagePath] = useState('');
  const [imageName, setImageName] = useState('');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [notice, setNotice] = useState('');
  const [oneTimeKey, setOneTimeKey] = useState('');
  const [copyFeedback, setCopyFeedback] = useState('');
  const checkoutConfirmed = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    if (params.get('checkout') !== 'success' || !sessionId || checkoutConfirmed.current) return;
    checkoutConfirmed.current = true;
    confirmCheckout.mutate({ data: { sessionId } }, {
      onSuccess: () => {
        void client.invalidateQueries();
        window.history.replaceState({}, '', window.location.pathname);
      },
      onError: () => setNotice('Die Zahlung wurde noch nicht bestätigt. Bitte lade die Seite erneut oder öffne die Abrechnung.'),
    });
  }, []);

  const values = form.watch();
  const audienceParams = useMemo(() => ({
    gender: values.gender,
    ...(values.ageFrom ? { ageFrom: Number(values.ageFrom) } : {}),
    ...(values.ageTo ? { ageTo: Number(values.ageTo) } : {}),
    ...(values.city.trim() ? { city: values.city.trim() } : {}),
    ...(values.studioId ? { studioId: Number(values.studioId) } : {}),
  }), [values.gender, values.ageFrom, values.ageTo, values.city, values.studioId]);
  const audience = useGetMarketingAudienceCount(audienceParams, {
    query: {
      queryKey: ['marketing-audience-count', audienceParams],
      enabled: subscription.data?.active === true,
    },
  });

  const active = subscription.data?.active === true;
  const canManageBilling = role === 'district_manager';
  const marketingAccess = apiCatalog.data?.find(entry => entry.serviceKey === 'marketing');
  const uploadImage = async (file?: File) => {
    if (!file) return;
    setUploadError('');
    setNotice('');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setUploadError('Bitte PNG, JPEG oder WebP bis maximal 5 MB auswählen.');
      return;
    }
    setUploadBusy(true);
    try {
      const upload = await requestUpload.mutateAsync({ data: { contentType: file.type as 'image/png' | 'image/jpeg' | 'image/webp', size: file.size } });
      const result = await fetch(upload.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!result.ok) throw new Error('Das Bild konnte nicht hochgeladen werden.');
      setImagePath(upload.objectPath);
      setImageName(file.name);
      setNotice('Bild ist bereit für deinen Kampagnenentwurf.');
    } catch (error) {
      setUploadError(errorMessage(error, 'Bild-Upload fehlgeschlagen. Bitte erneut versuchen.'));
    } finally {
      setUploadBusy(false);
    }
  };

  const campaignInput = (fields: CampaignFields): MarketingCampaignInput => ({
    headline: fields.headline.trim(),
    bodyText: fields.bodyText.trim(),
    imagePath,
    audience: {
      gender: fields.gender,
      ageFrom: fields.ageFrom ? Number(fields.ageFrom) : null,
      ageTo: fields.ageTo ? Number(fields.ageTo) : null,
      city: fields.city.trim() || null,
      studioId: fields.studioId ? Number(fields.studioId) : null,
    },
  });

  const saveDraft = form.handleSubmit(fields => {
    setNotice('');
    createCampaign.mutate({ data: campaignInput(fields) }, {
      onSuccess: campaign => {
        void client.invalidateQueries({ queryKey: getListMarketingCampaignsQueryKey() });
        setNotice(`„${campaign.headline}“ wurde als Entwurf gespeichert.`);
      },
    });
  });

  const sendDraft = (campaign: MarketingCampaign, audienceCount: number, eligible: number) => {
    const confirmation = `Kampagne „${campaign.headline}“ jetzt senden?\n\n${audienceCount ?? '—'} passende Mitglieder · ${eligible ?? '—'} davon mit erreichbarer E-Mail-Adresse.\n\nEs erhalten ausschließlich Mitglieder mit dokumentierter Marketing-Einwilligung eine E-Mail.`;
    if (!window.confirm(confirmation)) return;
    setNotice('');
    sendCampaign.mutate({ id: campaign.id }, {
      onSuccess: result => {
        void client.invalidateQueries({ queryKey: getListMarketingCampaignsQueryKey() });
        setNotice(result.failedCount
          ? `Kampagne teilweise versendet: ${result.recipientCount} erfolgreich, ${result.failedCount} fehlgeschlagen. Du kannst erneut senden.`
          : `Kampagne versendet: ${result.recipientCount} Empfängerinnen und Empfänger.`);
      },
    });
  };

  const openCheckout = () => checkout.mutate(undefined, {
    onSuccess: result => { window.location.assign(result.url); },
  });
  const openBillingPortal = () => billingPortal.mutate(undefined, {
    onSuccess: result => { window.location.assign(result.url); },
  });
  const rotate = () => {
    if (marketingAccess?.accessStatus !== 'approved') {
      setNotice('Bitte beantrage zuerst den Marketing-API-Zugang in den REST-API-Einstellungen.');
      return;
    }
    if (apiKey.data?.active && !window.confirm('Den bisherigen Agentur-Schlüssel ersetzen? Der neue Schlüssel wird nur einmal angezeigt.')) return;
    setOneTimeKey('');
    rotateKey.mutate(undefined, {
      onSuccess: result => {
        setOneTimeKey(result.key);
        void client.invalidateQueries({ queryKey: getGetMarketingApiKeyQueryKey() });
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

  const retryAll = () => {
    void subscription.refetch();
    void campaigns.refetch();
    void studios.refetch();
    void apiKey.refetch();
  };

  if (subscription.isLoading) return <main className="marketing-page"><MarketingSkeleton /></main>;
  if (subscription.isError || !subscription.data) return <main className="marketing-page">
    <div className="marketing-error" role="alert"><CircleHelp size={22} /><div><strong>Marketingstatus nicht verfügbar</strong><p>{errorMessage(subscription.error, 'Die Daten konnten nicht geladen werden.')}</p></div><button className="button button-outline" onClick={retryAll} data-testid="button-retry-marketing">Erneut versuchen</button></div>
  </main>;

  return <main className="marketing-page">
    <header className="marketing-heading">
      <div>
        <div className="eyebrow">Fiudia / Kommunikation / Marketing</div>
        <h1>Marketing, das ankommt.</h1>
        <p>Erstelle gezielte Kampagnen für deine Mitglieder — mit Einwilligung und Reichweite im Blick.</p>
      </div>
      <Link href="/settings/api" className="button button-outline marketing-doc-link" data-testid="link-marketing-docs">REST-API-Katalog <ArrowUpRight size={15} /></Link>
    </header>

    {!active ? <section className="marketing-paywall" aria-labelledby="marketing-paywall-title">
      <div className="marketing-paywall-visual"><span className="marketing-orbit marketing-orbit-one" /><span className="marketing-orbit marketing-orbit-two" /><Megaphone size={34} strokeWidth={1.5} /></div>
      <div className="marketing-paywall-copy">
        <div className="eyebrow">Fiudia Marketing</div>
        <h2 id="marketing-paywall-title">Deine Mitglieder. Deine Nachricht.</h2>
        <p>Erreiche deine Community mit gezielten E-Mail-Kampagnen und verwalte alles direkt in Fiudia.</p>
        <div className="marketing-price"><strong>99 €</strong><span>/ Monat<br />pro Organisation</span></div>
        {canManageBilling ? <button type="button" className="button button-dark" onClick={openCheckout} disabled={checkout.isPending} data-testid="button-marketing-checkout">
          {checkout.isPending ? 'Checkout wird vorbereitet …' : 'Marketing freischalten'} <ChevronRight size={16} />
        </button> : <p className="marketing-inline-error">Bitte die Bezirksleitung, das Marketing-Abo für die Organisation abzuschließen.</p>}
        {checkout.isError && <p className="marketing-inline-error" role="alert" data-testid="error-marketing-checkout">{errorMessage(checkout.error, 'Checkout konnte nicht gestartet werden.')}</p>}
      </div>
      <div className="marketing-paywall-aside"><span>01 / Reichweite</span><strong>Mitglieder direkt erreichen.</strong><span>02 / Kontrolle</span><strong>Nur mit dokumentierter Einwilligung.</strong></div>
    </section> : <>
      <section className="marketing-plan-bar">
        <div className="marketing-plan-status"><span className="marketing-live-dot" /><div><strong>Marketing ist aktiv</strong><small>99 € / Monat · nächste Verlängerung {dateLabel(subscription.data.currentPeriodEnd)}</small></div></div>
         {canManageBilling && <button type="button" className="button button-outline" onClick={openBillingPortal} disabled={billingPortal.isPending} data-testid="button-marketing-billing">
          <CalendarClock size={15} /> {billingPortal.isPending ? 'Wird geöffnet …' : 'Abrechnung verwalten'}
         </button>}
        {billingPortal.isError && <span className="marketing-inline-error" role="alert">{errorMessage(billingPortal.error, 'Abrechnungsportal konnte nicht geöffnet werden.')}</span>}
      </section>

      <div className="marketing-workspace">
        <section className="marketing-composer" aria-labelledby="marketing-composer-title">
          <div className="marketing-section-heading">
            <div><span className="marketing-step">01</span><div><div className="eyebrow">Kampagne vorbereiten</div><h2 id="marketing-composer-title">Eine Nachricht mit Ziel.</h2></div></div>
            <span className="marketing-private-note"><ShieldCheck size={15} /> Keine Mitgliederlisten, nur aggregierte Zahlen</span>
          </div>
          <Form {...form}>
            <form className="marketing-form" onSubmit={saveDraft} data-testid="form-marketing-campaign">
              <div className="marketing-content-column">
                <FormField control={form.control} name="headline" rules={{ required: 'Bitte eine Überschrift eingeben.', maxLength: { value: 160, message: 'Maximal 160 Zeichen.' } }} render={({ field }) => <FormItem className="field"><FormLabel>Überschrift (H1)</FormLabel><FormControl><input {...field} maxLength={160} placeholder="Dein nächster Studio-Moment" data-testid="input-marketing-headline" /></FormControl><FormMessage /></FormItem>} />
                <FormField control={form.control} name="bodyText" rules={{ required: 'Bitte einen Nachrichtentext eingeben.', maxLength: { value: 6000, message: 'Maximal 6.000 Zeichen.' } }} render={({ field }) => <FormItem className="field"><FormLabel>Nachricht</FormLabel><FormControl><textarea {...field} rows={7} maxLength={6000} placeholder="Was sollen deine Mitglieder wissen?" data-testid="input-marketing-body" /></FormControl><span className="marketing-char-count">{field.value.length} / 6.000</span><FormMessage /></FormItem>} />
                <div className="marketing-upload-box">
                  <ImagePlus size={18} />
                  <div><strong>{imageName || 'Kampagnenbild hinzufügen'}</strong><span>{imageName ? 'Bild hochgeladen und bereit' : 'PNG, JPEG oder WebP · bis 5 MB'}</span></div>
                  <label className="button button-outline marketing-upload-button">{uploadBusy ? 'Lädt …' : imageName ? 'Ändern' : 'Bild auswählen'}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploadBusy} onChange={event => { void uploadImage(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} data-testid="input-marketing-image" /></label>
                </div>
                {uploadError && <p className="marketing-inline-error" role="alert" data-testid="error-marketing-image">{uploadError}</p>}
                {createCampaign.isError && <p className="marketing-inline-error" role="alert" data-testid="error-marketing-save">{errorMessage(createCampaign.error, 'Kampagne konnte nicht gespeichert werden.')}</p>}
              </div>

              <aside className="marketing-audience-column">
                <div className="marketing-audience-head"><Users size={17} /><div><strong>Deine Zielgruppe</strong><span>Filter passen sich live an.</span></div></div>
                <FormField control={form.control} name="gender" render={({ field }) => <FormItem className="field"><FormLabel>Geschlecht</FormLabel><FormControl><select {...field} data-testid="select-marketing-gender"><option value="all">Alle</option><option value="female">Weiblich</option><option value="male">Männlich</option><option value="diverse">Divers</option></select></FormControl><FormMessage /></FormItem>} />
                <div className="marketing-age-fields">
                  <FormField control={form.control} name="ageFrom" rules={{ validate: value => !value || (Number(value) >= 0 && Number(value) <= 120) || 'Alter muss zwischen 0 und 120 liegen.' }} render={({ field }) => <FormItem className="field"><FormLabel>Alter von</FormLabel><FormControl><input {...field} type="number" min="0" max="120" placeholder="Alle" data-testid="input-marketing-age-from" /></FormControl><FormMessage /></FormItem>} />
                  <FormField control={form.control} name="ageTo" rules={{ validate: value => !value || (Number(value) >= 0 && Number(value) <= 120) || 'Alter muss zwischen 0 und 120 liegen.' }} render={({ field }) => <FormItem className="field"><FormLabel>Alter bis</FormLabel><FormControl><input {...field} type="number" min="0" max="120" placeholder="Alle" data-testid="input-marketing-age-to" /></FormControl><FormMessage /></FormItem>} />
                </div>
                {values.ageFrom && values.ageTo && Number(values.ageTo) < Number(values.ageFrom) && <p className="marketing-inline-error" role="alert">Das Höchstalter muss mindestens dem Mindestalter entsprechen.</p>}
                <FormField control={form.control} name="city" render={({ field }) => <FormItem className="field"><FormLabel>Stadt</FormLabel><FormControl><input {...field} maxLength={120} placeholder="Alle Städte" data-testid="input-marketing-city" /></FormControl><FormMessage /></FormItem>} />
                <FormField control={form.control} name="studioId" render={({ field }) => <FormItem className="field"><FormLabel>Studio</FormLabel><FormControl><select {...field} data-testid="select-marketing-studio"><option value="">Alle Studios</option>{studios.data?.map(studio => <option value={studio.id} key={studio.id}>{studio.name} · {studio.city}</option>)}</select></FormControl><FormMessage /></FormItem>} />
                {studios.isError && <p className="marketing-inline-error" role="alert">Studios konnten nicht geladen werden. <button type="button" onClick={() => void studios.refetch()} data-testid="button-retry-marketing-studios">Erneut versuchen</button></p>}
                <div className="marketing-audience-count" aria-live="polite" data-testid="panel-marketing-audience">
                  <div><span>Passende Mitglieder</span><strong>{audience.isLoading ? '…' : audience.data?.count ?? '—'}</strong></div>
                  <div><span>Mit E-Mail erreichbar</span><strong>{audience.isLoading ? '…' : audience.data?.eligibleEmailCount ?? '—'}</strong></div>
                </div>
                {audience.isError && <p className="marketing-inline-error" role="alert" data-testid="error-marketing-audience">Reichweite konnte nicht geladen werden. <button type="button" onClick={() => void audience.refetch()} data-testid="button-retry-marketing-audience">Erneut versuchen</button></p>}
                <p className="marketing-consent-note"><ShieldCheck size={15} /> Nur Mitglieder mit dokumentierter Marketing-Einwilligung erhalten eine E-Mail.</p>
              </aside>
              <div className="marketing-form-footer">
                <span>{notice && <span className="marketing-success" role="status" data-testid="status-marketing-feedback"><Check size={14} />{notice}</span>}</span>
                <button type="submit" className="button button-dark" disabled={createCampaign.isPending || uploadBusy || !imagePath || (values.ageFrom !== '' && values.ageTo !== '' && Number(values.ageTo) < Number(values.ageFrom))} data-testid="button-save-marketing-draft">
                  {createCampaign.isPending ? 'Wird gespeichert …' : 'Entwurf speichern'} <ChevronRight size={15} />
                </button>
              </div>
            </form>
          </Form>
        </section>

        <section className="marketing-campaign-section" aria-labelledby="marketing-campaigns-title">
          <div className="marketing-section-heading marketing-campaigns-heading">
            <div><span className="marketing-step">02</span><div><div className="eyebrow">Übersicht</div><h2 id="marketing-campaigns-title">Deine Kampagnen.</h2></div></div>
            <span className="marketing-campaign-count">{campaigns.data?.length ?? 0} gesamt</span>
          </div>
          {campaigns.isLoading ? <MarketingSkeleton /> : campaigns.isError ? <div className="marketing-error" role="alert"><p>Kampagnen konnten nicht geladen werden.</p><button className="button button-outline" onClick={() => void campaigns.refetch()} data-testid="button-retry-marketing-campaigns">Erneut versuchen</button></div> : campaigns.data?.length ? <div className="marketing-campaign-list" data-testid="list-marketing-campaigns">
            {campaigns.data.map(campaign => <CampaignRow campaign={campaign} key={campaign.id} onSend={sendDraft} sending={sendCampaign.isPending} />)}
          </div> : <div className="marketing-empty"><span><Megaphone size={22} /></span><div><strong>Noch keine Kampagne.</strong><p>Dein erster Entwurf wartet oben auf dich.</p></div></div>}
          {sendCampaign.isError && <p className="marketing-inline-error" role="alert" data-testid="error-marketing-send">{errorMessage(sendCampaign.error, 'Kampagne konnte nicht versendet werden.')}</p>}
        </section>

        {canManageBilling && <section className="marketing-api-section" aria-labelledby="marketing-api-title">
          <div className="marketing-section-heading">
            <div><span className="marketing-step">03</span><div><div className="eyebrow">Für deine Agentur</div><h2 id="marketing-api-title">Anbindung & Schlüssel.</h2></div></div>
            <KeyRound size={20} className="marketing-key-icon" />
          </div>
          <div className="marketing-api-card">
            <div className="marketing-api-details"><strong>Marketing API</strong><p>Verbinde ein externes System mit deiner Fiudia-Mitgliederreichweite.</p><label htmlFor="marketing-endpoint">Audience-Endpunkt</label><div className="marketing-endpoint-field"><input id="marketing-endpoint" readOnly value={`${window.location.origin}/api/external/marketing/audience-count`} data-testid="input-marketing-endpoint" /><Copy size={15} aria-hidden="true" /></div><small>Nur aggregierte Reichweiten — keine personenbezogenen Daten.</small></div>
            <div className="marketing-key-panel">
              <div className="marketing-key-status"><span className={apiKey.data?.active ? 'marketing-key-indicator active' : 'marketing-key-indicator'} />{apiKey.isLoading ? 'Schlüsselstatus wird geladen …' : apiKey.isError ? 'Schlüsselstatus nicht verfügbar' : apiKey.data?.active ? `Aktiv · ${apiKey.data.keyPrefix ?? 'Schlüssel vorhanden'}` : 'Noch kein Schlüssel erstellt'}</div>
              {apiKey.data?.lastUsedAt && <small>Zuletzt verwendet am {dateLabel(apiKey.data.lastUsedAt)}</small>}
              {apiKey.isError && <button type="button" className="marketing-text-button" onClick={() => void apiKey.refetch()} data-testid="button-retry-marketing-key">Erneut laden</button>}
              {marketingAccess?.accessStatus === 'approved'
                ? <button type="button" className="button button-dark" onClick={rotate} disabled={rotateKey.isPending || apiKey.isLoading} data-testid="button-rotate-marketing-key"><RotateCw size={15} />{rotateKey.isPending ? 'Schlüssel wird erstellt …' : apiKey.data?.active ? 'Schlüssel erneuern' : 'Schlüssel erstellen'}</button>
                : <Link href="/settings/api" className="button button-outline" data-testid="link-request-marketing-api">REST-API-Zugang beantragen <ArrowUpRight size={14} /></Link>}
              {rotateKey.isError && <p className="marketing-inline-error" role="alert" data-testid="error-marketing-key">{errorMessage(rotateKey.error, 'Schlüssel konnte nicht erstellt werden.')}</p>}
            </div>
            {oneTimeKey && <div className="marketing-key-reveal" role="status" data-testid="panel-marketing-key-reveal"><div><strong>Neuer Schlüssel — nur jetzt sichtbar</strong><p>Speichere ihn sicher. Fiudia zeigt ihn danach nicht erneut an.</p></div><code>{oneTimeKey}</code><button type="button" className="button button-outline" onClick={() => void copyKey()} data-testid="button-copy-marketing-key"><Copy size={14} /> Kopieren</button>{copyFeedback && <span>{copyFeedback}</span>}</div>}
          </div>
        </section>}
      </div>
    </>}
  </main>;
}
