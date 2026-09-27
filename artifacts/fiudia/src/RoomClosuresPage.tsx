import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearch } from 'wouter';
import { AlertTriangle, ArrowRight, DoorOpen, Plus, Trash2, X } from 'lucide-react';
import {
  getGetClosureEmailDeliveriesQueryKey, getGetClosurePushDeliveriesQueryKey, getListClosureAffectedCoursesQueryKey, getListClosureResolutionsQueryKey, getListCoursesQueryKey, getListMemberNotificationsQueryKey,
  getListStudioRoomClosuresQueryKey, getListStudioRoomsQueryKey, getListStudiosQueryKey, useCreateStudioRoom,
  useCreateStudioRoomClosure, useDeleteStudioRoomClosure, useGetClosureEmailDeliveries, useGetClosurePushDeliveries, useListClosureAffectedCourses,
  useListClosureResolutions, useListStudioRoomClosures, useListStudioRooms, useListStudios, useResolveCourseRoomClosure, useRetryClosureEmailDeliveries, useRetryClosurePushDeliveries,
} from '@workspace/api-client-react';
import type { ClosureAffectedCourse, ClosureCourseResolution, CourseClosureResolutionInput, Me, RoomClosure } from '@workspace/api-client-react';
import './RoomClosuresPage.css';

function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const object = error as { data?: unknown; message?: string; status?: number };
    const data = object.data;
    if (data && typeof data === 'object') {
      const body = data as { error?: unknown; message?: unknown; details?: unknown; issues?: unknown };
      for (const value of [body.error, body.message, body.details, body.issues]) {
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join(' · ');
      }
    }
    if (typeof data === 'string') return data;
    if (object.status === 409) return 'Konflikt: Bitte prüfe die aktuelle Planung und versuche es erneut.';
    if (object.message && !object.message.startsWith('Request failed')) return object.message;
  }
  return 'Die Anfrage konnte nicht abgeschlossen werden. Bitte prüfe deine Angaben und versuche es erneut.';
}

function formatDate(value: string) {
  const [year, month, day] = value.slice(0, 10).split('-');
  return year && month && day ? `${day}.${month}.${year}` : value;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function ConfirmDialog({ title, description, confirmLabel, onConfirm, onClose, busy }: {
  title: string; description: string; confirmLabel: string; onConfirm: () => void; onClose: () => void; busy?: boolean;
}) {
  return <div className="rooms-confirm-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="rooms-confirm" role="alertdialog" aria-modal="true" aria-labelledby="rooms-confirm-title" aria-describedby="rooms-confirm-description">
      <h2 id="rooms-confirm-title">{title}</h2><p id="rooms-confirm-description">{description}</p>
      <div className="rooms-confirm-actions"><button type="button" className="rooms-action" onClick={onClose} disabled={busy} data-testid="button-confirm-back">Zurück</button>
        <button type="button" className="rooms-action danger" onClick={onConfirm} disabled={busy} autoFocus data-testid="button-confirm-action">{busy ? 'Bitte warten …' : confirmLabel}</button></div>
    </div>
  </div>;
}

type Attempt = { courseId: number; data: CourseClosureResolutionInput };

function AffectedCourse({ course, closureId, studioId }: { course: ClosureAffectedCourse; closureId: number; studioId: number }) {
  const client = useQueryClient();
  const resolve = useResolveCourseRoomClosure();
  const [action, setAction] = useState<'relocate' | 'cancel' | null>(null);
  const [room, setRoom] = useState('');
  const [channel, setChannel] = useState<'in_app' | 'email' | 'push'>('in_app');
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [requestError, setRequestError] = useState('');

  function chooseAction(next: 'relocate' | 'cancel') {
    setAction(next); setAttempt(null); setSubmitted(false); setRequestError('');
    if (next === 'relocate') { setRoom(course.alternativeRooms[0] || ''); setShowAlternatives(true); }
  }

  function sendResolution(next: Attempt) {
    setRequestError('');
    resolve.mutate({ id: next.courseId, data: next.data }, {
      onSuccess: () => {
        setSubmitted(true);
        client.invalidateQueries({ queryKey: getListClosureAffectedCoursesQueryKey(studioId, closureId) });
        client.invalidateQueries({ queryKey: getListClosureResolutionsQueryKey(studioId, closureId) });
        client.invalidateQueries({ queryKey: getListStudioRoomClosuresQueryKey(studioId) });
        client.invalidateQueries({ queryKey: getListCoursesQueryKey() });
        client.invalidateQueries({ queryKey: getListMemberNotificationsQueryKey() });
      },
      onError: error => setRequestError(errorText(error)),
    });
  }

  function submit() {
    if (!action || resolve.isPending) return;
    if (action === 'relocate' && !course.alternativeRooms.includes(room)) {
      setRequestError('Bitte wähle einen verfügbaren Alternativraum.'); return;
    }
    if (attempt) { sendResolution(attempt); return; }
    if (action === 'cancel' && !confirmCancel) { setConfirmCancel(true); return; }
    const next: Attempt = { courseId: course.id, data: {
      closureId, action, ...(action === 'relocate' ? { room } : {}), channel, idempotencyKey: crypto.randomUUID(),
    } };
    setAttempt(next);
    sendResolution(next);
  }

  return <article className="rooms-course" data-testid={`card-affected-course-${course.id}`}>
    <div className="rooms-course-main"><div><h5>{course.title}</h5>
      <p>{formatTime(course.startsAt)} · {course.instructor} · {course.enrolled} Buchungen</p>
      <p>Geplant in {course.room}</p></div>
      <span className={`rooms-course-status ${course.resolved ? 'done' : ''}`} data-testid={`status-course-${course.id}`}>{course.resolved ? 'Bearbeitet' : 'Entscheidung offen'}</span>
    </div>
    <div className="rooms-course-actions">
      {!course.resolved && <><button type="button" className="rooms-action" onClick={() => chooseAction('relocate')} data-testid={`button-relocate-${course.id}`}>Raum wechseln</button>
      <button type="button" className="rooms-action danger" onClick={() => chooseAction('cancel')} data-testid={`button-cancel-course-${course.id}`}>Kurs absagen</button></>}
      <button type="button" className="rooms-action" onClick={() => setShowAlternatives(value => !value)} aria-expanded={showAlternatives} data-testid={`button-alternatives-${course.id}`}>Alternativen ansehen</button>
    </div>
    {showAlternatives && <div className="rooms-alternatives" data-testid={`text-alternatives-${course.id}`}>
      {course.alternativeRooms.length ? `Verfügbar: ${course.alternativeRooms.join(', ')}` : 'Für diesen Termin gibt es keinen verfügbaren Alternativraum.'}
    </div>}
    {action && !course.resolved && <div className="rooms-resolve">
      <div className="rooms-resolve-head"><strong>{action === 'relocate' ? 'Neuen Raum festlegen' : 'Absage vorbereiten'}</strong><button type="button" className="rooms-action" aria-label="Entscheidung schließen" onClick={() => { setAction(null); setAttempt(null); setRequestError(''); }} data-testid={`button-close-resolution-${course.id}`}><X size={14} /></button></div>
      {action === 'relocate' && <label className="rooms-field">Alternativraum
        <select value={room} onChange={event => { setRoom(event.target.value); setAttempt(null); setSubmitted(false); setRequestError(''); }} data-testid={`select-alternative-room-${course.id}`}><option value="">Raum auswählen</option>{course.alternativeRooms.map(option => <option key={option} value={option}>{option}</option>)}</select>
      </label>}
      <div className="rooms-field">Mitglieder informieren <div className="rooms-channels" role="group" aria-label="Benachrichtigungskanal">
        <button type="button" aria-pressed={channel === 'in_app'} onClick={() => { setChannel('in_app'); setAttempt(null); setSubmitted(false); }} data-testid={`button-channel-in-app-${course.id}`}>In-App</button>
        <button type="button" aria-pressed={channel === 'email'} onClick={() => { setChannel('email'); setAttempt(null); setSubmitted(false); }} data-testid={`button-channel-email-${course.id}`}>E-Mail</button>
        <button type="button" aria-pressed={channel === 'push'} onClick={() => { setChannel('push'); setAttempt(null); setSubmitted(false); }} data-testid={`button-channel-push-${course.id}`}>Push</button>
        <button type="button" disabled title="Noch nicht eingerichtet" data-testid={`button-channel-whatsapp-${course.id}`}>WhatsApp · geplant</button>
      </div></div>
      {action === 'cancel' && <p className="rooms-form-note">{channel === 'push'
        ? 'Push wird an Browser-Abonnenten versucht. Alle gebuchten Mitglieder erhalten zusätzlich eine In-App-Benachrichtigung. Ist der Push-Anbieter nicht bereit, kann die Anfrage bereits vor der Erfassung abgelehnt werden.'
        : `Gebuchte Mitglieder werden über ${channel === 'email' ? 'E-Mail' : 'In-App'} über die Kursabsage informiert.`}</p>}
      {requestError && <div className="rooms-alert" role="alert" data-testid={`error-resolution-${course.id}`}>{requestError}</div>}
      <div><button type="button" className="rooms-action primary" disabled={resolve.isPending || (action === 'relocate' && !room)} onClick={submit} data-testid={`button-submit-resolution-${course.id}`}>{resolve.isPending ? 'Entscheidung wird übermittelt …' : attempt ? 'Mit gleicher Anfrage erneut versuchen' : action === 'relocate' ? 'Raumwechsel bestätigen' : 'Absage prüfen'} <ArrowRight size={14} /></button></div>
    </div>}
    {submitted && <div className="rooms-notice" role="status" data-testid={`status-resolution-outcome-${course.id}`}>Entscheidung erfasst. Den aktuellen Zustellungsstatus findest du unten bei „Getroffene Entscheidungen“.</div>}
    {confirmCancel && <ConfirmDialog title="Kurs wirklich absagen?" description={channel === 'push'
      ? `„${course.title}“ wird abgesagt. Push wird an Browser-Abonnenten versucht; alle ${course.enrolled} gebuchten Mitglieder erhalten zusätzlich eine In-App-Benachrichtigung. Ist der Push-Anbieter nicht bereit, kann die Anfrage bereits vor der Erfassung abgelehnt werden.`
      : `„${course.title}“ wird abgesagt. ${course.enrolled} gebuchte Mitglieder werden über ${channel === 'email' ? 'E-Mail' : 'In-App'} informiert.`} confirmLabel="Kurs verbindlich absagen" busy={resolve.isPending} onClose={() => setConfirmCancel(false)} onConfirm={() => { setConfirmCancel(false); const next: Attempt = { courseId: course.id, data: { closureId, action: 'cancel', channel, idempotencyKey: crypto.randomUUID() } }; setAttempt(next); sendResolution(next); }} />}
  </article>;
}

function ResolutionOutcome({ resolution, studioId, closureId }: { resolution: ClosureCourseResolution; studioId: number; closureId: number }) {
  const client = useQueryClient();
  const [retryError, setRetryError] = useState('');
  const [pushRetryError, setPushRetryError] = useState('');
  const retry = useRetryClosureEmailDeliveries();
  const pushRetry = useRetryClosurePushDeliveries();
  const deliveryQuery = useGetClosureEmailDeliveries(resolution.resolutionId, {
    query: {
      queryKey: getGetClosureEmailDeliveriesQueryKey(resolution.resolutionId),
      enabled: resolution.channel === 'email',
      refetchOnMount: 'always',
      refetchInterval: query => {
        const deliveries = query.state.data?.deliveries;
        return deliveries?.some(item => item.status === 'pending' || item.status === 'sending') ? 5000 : 15000;
      },
    },
  });
  const pushDeliveryQuery = useGetClosurePushDeliveries(resolution.resolutionId, {
    query: {
      queryKey: getGetClosurePushDeliveriesQueryKey(resolution.resolutionId),
      enabled: resolution.channel === 'push',
      refetchOnMount: 'always',
      refetchInterval: query => {
        const deliveries = query.state.data?.deliveries;
        return deliveries?.some(item => item.status === 'pending' || item.status === 'sending') ? 5000 : 15000;
      },
    },
  });
  const deliveries = deliveryQuery.data?.deliveries ?? resolution.deliveries;
  const pushDeliveries = pushDeliveryQuery.data?.deliveries ?? [];
  const counts = deliveries.reduce((total, delivery) => {
    if (delivery.status !== 'skipped') total[delivery.status] += 1;
    return total;
  }, { sent: 0, failed: 0, pending: 0, sending: 0 });
  const pushCounts = pushDeliveries.reduce((total, delivery) => {
    total[delivery.status] += 1;
    return total;
  }, { sent: 0, failed: 0, pending: 0, sending: 0, skipped: 0 });
  const hasUnsent = counts.failed + counts.pending > 0;
  const hasPushUnsent = pushCounts.failed + pushCounts.pending > 0;
  function retryEmail() {
    setRetryError('');
    retry.mutate({ resolutionId: resolution.resolutionId }, {
      onSuccess: report => {
        client.setQueryData(getGetClosureEmailDeliveriesQueryKey(resolution.resolutionId), report);
        client.invalidateQueries({ queryKey: getGetClosureEmailDeliveriesQueryKey(resolution.resolutionId) });
        client.invalidateQueries({ queryKey: getListClosureResolutionsQueryKey(studioId, closureId) });
        client.invalidateQueries({ queryKey: getListMemberNotificationsQueryKey() });
      },
      onError: error => setRetryError(errorText(error)),
    });
  }
  function retryPush() {
    setPushRetryError('');
    pushRetry.mutate({ resolutionId: resolution.resolutionId }, {
      onSuccess: report => {
        client.setQueryData(getGetClosurePushDeliveriesQueryKey(resolution.resolutionId), report);
        client.invalidateQueries({ queryKey: getGetClosurePushDeliveriesQueryKey(resolution.resolutionId) });
        client.invalidateQueries({ queryKey: getListClosureResolutionsQueryKey(studioId, closureId) });
        client.invalidateQueries({ queryKey: getListMemberNotificationsQueryKey() });
      },
      onError: error => setPushRetryError(errorText(error)),
    });
  }
  return <article className="rooms-outcome" data-testid={`status-resolution-${resolution.resolutionId}`}>
    <strong>{resolution.courseTitle} · {resolution.action === 'cancel' ? 'Abgesagt' : `Verlegt nach ${resolution.room ?? 'anderer Raum'}`}</strong>
    <p>{resolution.channel === 'email' ? `E-Mail-Zustellung: ${counts.sent} gesendet · ${counts.failed} fehlgeschlagen · ${counts.pending} ausstehend · ${counts.sending} in Bearbeitung` : resolution.channel === 'push'
      ? `Push-Zustellung pro Browser-Gerät: ${pushCounts.sent} gesendet · ${pushCounts.failed} fehlgeschlagen · ${pushCounts.pending} ausstehend · ${pushCounts.sending} in Bearbeitung · ${pushCounts.skipped} ohne Push-Abo (In-App-Hinweis erstellt).`
      : 'In-App-Benachrichtigung erfasst.'}</p>
    {resolution.channel === 'email' && <>
      {deliveryQuery.isLoading && <div className="rooms-skeleton" aria-label="Zustellungen werden geladen" />}
      {deliveryQuery.isError && <div className="rooms-alert" role="alert">Aktuelle Zustellungen konnten nicht geladen werden. {errorText(deliveryQuery.error)} <button type="button" className="rooms-action" onClick={() => deliveryQuery.refetch()} data-testid={`button-reload-deliveries-${resolution.resolutionId}`}>Erneut laden</button></div>}
      {deliveries.length > 0 ? <ul>{deliveries.map(delivery => <li key={delivery.id} className={delivery.status === 'failed' ? 'failed' : ''} data-testid={`status-email-delivery-${delivery.id}`}>Mitglied #{delivery.memberId}: {delivery.status === 'sent' ? 'Gesendet' : delivery.status === 'failed' ? 'Fehlgeschlagen' : delivery.status === 'sending' ? 'Wird gesendet' : 'Ausstehend'}{delivery.error ? ` · ${delivery.error}` : ''}</li>)}</ul> : <p>Keine E-Mail-Zustellungen vorhanden.</p>}
      {hasUnsent && <button type="button" className="rooms-action" disabled={retry.isPending} onClick={retryEmail} data-testid={`button-retry-delivery-${resolution.resolutionId}`}>{retry.isPending ? 'Zustellungen werden erneut versucht …' : 'Fehlgeschlagene / ausstehende E-Mails erneut versuchen'}</button>}
      {retryError && <div className="rooms-alert" role="alert" data-testid={`error-retry-delivery-${resolution.resolutionId}`}>{retryError}</div>}
    </>}
    {resolution.channel === 'push' && <>
      {pushDeliveryQuery.isLoading && <div className="rooms-skeleton" aria-label="Push-Zustellungen werden geladen" />}
      {pushDeliveryQuery.isError && <div className="rooms-alert" role="alert" data-testid={`error-load-push-deliveries-${resolution.resolutionId}`}>Aktuelle Push-Zustellungen konnten nicht geladen werden. {errorText(pushDeliveryQuery.error)} <button type="button" className="rooms-action" onClick={() => pushDeliveryQuery.refetch()} data-testid={`button-reload-push-deliveries-${resolution.resolutionId}`}>Erneut laden</button></div>}
      {pushDeliveries.length > 0 ? <ul>{pushDeliveries.map(delivery => <li key={delivery.id} className={delivery.status === 'failed' ? 'failed' : ''} data-testid={`status-push-delivery-${delivery.id}`}>Browser-Gerät · Mitglied #{delivery.memberId}: {delivery.status === 'skipped' ? 'Kein Push-Abo · In-App-Hinweis erstellt' : delivery.status === 'sent' ? 'Gesendet' : delivery.status === 'failed' ? 'Fehlgeschlagen' : delivery.status === 'sending' ? 'Wird gesendet' : 'Ausstehend'}{delivery.error ? ` · ${delivery.error}` : ''}</li>)}</ul> : !pushDeliveryQuery.isLoading && !pushDeliveryQuery.isError && <p>Keine Push-Geräte-Zustellungen vorhanden. Das bedeutet nicht, dass die In-App-Benachrichtigung fehlgeschlagen ist.</p>}
      {hasPushUnsent && <button type="button" className="rooms-action" disabled={pushRetry.isPending} onClick={retryPush} data-testid={`button-retry-push-delivery-${resolution.resolutionId}`}>{pushRetry.isPending ? 'Push-Zustellungen werden erneut versucht …' : 'Fehlgeschlagene / ausstehende Push-Zustellungen erneut versuchen'}</button>}
      {pushRetryError && <div className="rooms-alert" role="alert" data-testid={`error-retry-push-delivery-${resolution.resolutionId}`}>{pushRetryError}</div>}
    </>}
  </article>;
}

function ClosureCard({ closure, studioId, onDelete, deleting, initiallyOpen }: { closure: RoomClosure; studioId: number; onDelete: (closure: RoomClosure) => void; deleting: boolean; initiallyOpen: boolean }) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  useEffect(() => { if (initiallyOpen) setExpanded(true); }, [initiallyOpen]);
  const affected = useListClosureAffectedCourses(studioId, closure.id, { query: { queryKey: getListClosureAffectedCoursesQueryKey(studioId, closure.id), enabled: expanded, refetchOnMount: 'always', staleTime: 0 } });
  const resolutions = useListClosureResolutions(studioId, closure.id, { query: { queryKey: getListClosureResolutionsQueryKey(studioId, closure.id), enabled: expanded, refetchOnMount: 'always', refetchInterval: expanded ? 15000 : false, staleTime: 0 } });
  const open = affected.data?.filter(course => !course.resolved).length ?? 0;
  return <article className={`rooms-closure ${expanded ? 'is-selected' : ''}`} data-testid={`card-closure-${closure.id}`}>
    <div className="rooms-closure-top"><div><small>Raumsperrung · {formatDate(closure.fromDate)} – {formatDate(closure.toDate)}</small><h3>{closure.roomName}</h3><p>{closure.reason}</p><p>Verantwortlich: {closure.responsible}</p></div>
      <div className="rooms-closure-actions"><button type="button" className="rooms-action" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} data-testid={`button-view-affected-${closure.id}`}>{expanded ? 'Kurse ausblenden' : 'Betroffene Kurse ansehen'} {expanded && affected.data ? `(${affected.data.length})` : ''}</button>
        <button type="button" className="rooms-action danger" aria-label={`Sperrung für ${closure.roomName} löschen`} onClick={() => onDelete(closure)} disabled={deleting} data-testid={`button-delete-closure-${closure.id}`}><Trash2 size={15} /></button></div>
    </div>
    {expanded && <div className="rooms-affected">
      <h4>Betroffene Kurse {affected.data && `· ${affected.data.length}`}</h4>
      {affected.data && <p className="rooms-muted" data-testid={`text-affected-count-${closure.id}`}>{open} offen · {resolutions.data?.length ?? 0} entschieden. Zeitraum einschließlich beider Kalendertage.</p>}
      {affected.isLoading ? <div className="rooms-skeleton" aria-label="Kurse werden geladen" /> : affected.isError ? <div className="rooms-alert" role="alert">Betroffene Kurse konnten nicht geladen werden. {errorText(affected.error)} <button type="button" className="rooms-action" onClick={() => affected.refetch()} data-testid={`button-retry-affected-${closure.id}`}>Erneut laden</button></div>
        : !affected.data?.length ? <div className="rooms-empty">Keine offenen Kurse in diesem Zeitraum betroffen.</div>
        : affected.data.map(course => <AffectedCourse key={course.id} course={course} closureId={closure.id} studioId={studioId} />)}
      <div className="rooms-resolution-history"><h4>Getroffene Entscheidungen {resolutions.data && `· ${resolutions.data.length}`}</h4>
        {resolutions.isLoading ? <div className="rooms-skeleton" aria-label="Entscheidungen werden geladen" /> : resolutions.isError ? <div className="rooms-alert" role="alert">Entscheidungen konnten nicht geladen werden. {errorText(resolutions.error)} <button type="button" className="rooms-action" onClick={() => resolutions.refetch()} data-testid={`button-retry-resolutions-${closure.id}`}>Erneut laden</button></div>
          : !resolutions.data?.length ? <p className="rooms-muted">Noch keine Kursentscheidungen für diese Sperrung.</p>
          : resolutions.data.map(resolution => <ResolutionOutcome key={resolution.resolutionId} resolution={resolution} studioId={studioId} closureId={closure.id} />)}
      </div>
    </div>}
  </article>;
}

export default function RoomClosuresPage({ me }: { me: Me }) {
  const client = useQueryClient();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const requestedClosure = Number(params.get('closure'));
  const targetClosureId = Number.isSafeInteger(requestedClosure) && requestedClosure > 0 ? requestedClosure : null;
  const requestedStudio = Number(params.get('studio'));
  const targetStudioId = Number.isSafeInteger(requestedStudio) && requestedStudio > 0 ? requestedStudio : null;
  const district = me.role === 'district_manager';
  const studios = useListStudios({ query: { enabled: district, queryKey: getListStudiosQueryKey() } });
  const [selectedStudio, setSelectedStudio] = useState<number | null>(null);
  const linkedStudioId = district && targetStudioId && studios.data?.some(studio => studio.id === targetStudioId) ? targetStudioId : null;
  useEffect(() => { if (linkedStudioId) setSelectedStudio(linkedStudioId); }, [linkedStudioId]);
  const studioId = district ? (selectedStudio ?? linkedStudioId ?? studios.data?.[0]?.id ?? 0) : (me.studioId ?? 0);
  const rooms = useListStudioRooms(studioId, { query: { enabled: studioId > 0, queryKey: getListStudioRoomsQueryKey(studioId), refetchOnMount: 'always', staleTime: 0 } });
  const closures = useListStudioRoomClosures(studioId, { query: { enabled: studioId > 0, queryKey: getListStudioRoomClosuresQueryKey(studioId), refetchOnMount: 'always', staleTime: 0 } });
  const createRoom = useCreateStudioRoom();
  const createClosure = useCreateStudioRoomClosure();
  const deleteClosure = useDeleteStudioRoomClosure();
  const [roomName, setRoomName] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ roomName: '', fromDate: '', toDate: '', reason: '', responsible: '' });
  const [formError, setFormError] = useState('');
  const [roomError, setRoomError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [newClosureId, setNewClosureId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RoomClosure | null>(null);
  const [deleteError, setDeleteError] = useState('');

  function addRoom(event: React.FormEvent) {
    event.preventDefault(); setRoomError('');
    if (!roomName.trim()) { setRoomError('Bitte gib einen Raumnamen ein.'); return; }
    createRoom.mutate({ studioId, data: { name: roomName.trim() } }, { onSuccess: () => { setRoomName(''); client.invalidateQueries({ queryKey: getListStudioRoomsQueryKey(studioId) }); }, onError: error => setRoomError(errorText(error)) });
  }
  function addClosure(event: React.FormEvent) {
    event.preventDefault(); setFormError('');
    if (form.toDate < form.fromDate) { setFormError('Das Enddatum muss am oder nach dem Startdatum liegen.'); return; }
    createClosure.mutate({ studioId, data: { ...form, roomName: form.roomName.trim(), reason: form.reason.trim(), responsible: form.responsible.trim() } }, {
      onSuccess: created => {
        setFeedback(`Sperrung für ${created.roomName} angelegt. Die Anzahl betroffener Kurse wird unten geladen.`);
        setNewClosureId(created.id);
        setFormOpen(false); setForm({ roomName: '', fromDate: '', toDate: '', reason: '', responsible: '' });
        client.invalidateQueries({ queryKey: getListStudioRoomClosuresQueryKey(studioId) });
        client.invalidateQueries({ queryKey: getListClosureAffectedCoursesQueryKey(studioId, created.id) });
        client.invalidateQueries({ queryKey: getListClosureResolutionsQueryKey(studioId, created.id) });
      }, onError: error => setFormError(errorText(error)),
    });
  }
  function removeClosure() {
    if (!deleteTarget) return;
    setDeleteError('');
    deleteClosure.mutate({ studioId, closureId: deleteTarget.id }, {
      onSuccess: () => { client.invalidateQueries({ queryKey: getListStudioRoomClosuresQueryKey(studioId) }); client.invalidateQueries({ queryKey: getListClosureAffectedCoursesQueryKey(studioId, deleteTarget.id) }); client.removeQueries({ queryKey: getListClosureResolutionsQueryKey(studioId, deleteTarget.id) }); setDeleteTarget(null); setFeedback('Raumsperrung gelöscht. Bereits getroffene Kursentscheidungen bleiben bestehen.'); },
      onError: error => setDeleteError(errorText(error)),
    });
  }
  return <div className="rooms-page">
    <header className="rooms-head"><div><div className="eyebrow">Workspace / Planung</div><h1>Räume &amp; Sperrungen</h1><p>Räume verwalten, Konflikte prüfen und gebuchte Mitglieder verlässlich informieren.</p></div>
      {district && <label className="rooms-studio-select">Studio auswählen<select value={studioId || ''} onChange={event => { setSelectedStudio(Number(event.target.value)); setFeedback(''); setNewClosureId(null); setFormOpen(false); }} data-testid="select-room-studio">
        {studios.data?.map(studio => <option value={studio.id} key={studio.id}>{studio.name} · {studio.city}</option>)}
      </select></label>}</header>
    {studios.isError && district ? <div className="rooms-alert" role="alert">Studios konnten nicht geladen werden. <button type="button" className="rooms-action" onClick={() => studios.refetch()} data-testid="button-retry-studios">Erneut versuchen</button></div>
      : !studioId ? <div className="rooms-empty">Noch kein Studio verfügbar.</div> : <>
      <div className="rooms-summary"><span>{rooms.data?.length ?? '–'} Räume</span><span>{closures.data?.length ?? '–'} Sperrungen</span><span>Lokale Kalendertage · inklusive Start und Ende</span></div>
      {feedback && <div className="rooms-notice" role="status" data-testid="status-room-feedback">{feedback}</div>}
      <div className="rooms-columns"><div><section className="rooms-panel"><div className="rooms-panel-head"><div><h2>Raumverzeichnis</h2><p>Alle nutzbaren Räume dieses Studios.</p></div><span className="rooms-count">{rooms.data?.length ?? '–'}</span></div>
        {rooms.isLoading ? <div className="rooms-skeleton" aria-label="Räume werden geladen" /> : rooms.isError ? <div className="rooms-alert" role="alert">Räume konnten nicht geladen werden. {errorText(rooms.error)} <button type="button" className="rooms-action" onClick={() => rooms.refetch()} data-testid="button-retry-rooms">Erneut laden</button></div> : rooms.data?.length ? <ul className="rooms-assets">{rooms.data.map(room => <li key={room.id} data-testid={`text-room-${room.id}`}><DoorOpen size={17} />{room.name}</li>)}</ul> : <div className="rooms-empty">Noch keine Räume erfasst. Lege den ersten Raum an, um Sperrungen zu planen.</div>}
        <form className="rooms-inline-form" onSubmit={addRoom}><input aria-label="Neuer Raumname" maxLength={80} value={roomName} onChange={event => setRoomName(event.target.value)} placeholder="Neuen Raum benennen" data-testid="input-new-room" /><button type="submit" className="rooms-icon-button" aria-label="Raum hinzufügen" disabled={createRoom.isPending} data-testid="button-add-room"><Plus size={18} /></button></form>
        {roomError && <p className="rooms-alert" role="alert" data-testid="error-room">{roomError}</p>}
      </section></div>
      <section className="rooms-panel"><div className="rooms-panel-head"><div><h2>Raumsperrungen</h2><p>Eine Sperrung markiert den Raum für den gesamten Zeitraum als nicht verfügbar.</p></div><button type="button" className="rooms-action primary" onClick={() => { setFormOpen(open => !open); setFormError(''); }} aria-expanded={formOpen} data-testid="button-new-closure"><Plus size={15} /> Sperrung anlegen</button></div>
        {formOpen && <form className="rooms-closure-form" onSubmit={addClosure}>
          <div className="rooms-form-grid"><label className="rooms-field">Raum<select required value={form.roomName} onChange={event => setForm({ ...form, roomName: event.target.value })} data-testid="select-closure-room"><option value="">Raum auswählen</option>{rooms.data?.map(room => <option value={room.name} key={room.id}>{room.name}</option>)}</select></label>
            <label className="rooms-field">Verantwortlich<input required maxLength={160} value={form.responsible} onChange={event => setForm({ ...form, responsible: event.target.value })} placeholder="Name oder Team" data-testid="input-closure-responsible" /></label>
            <label className="rooms-field">Von (einschließlich)<input required type="date" value={form.fromDate} onChange={event => setForm({ ...form, fromDate: event.target.value })} data-testid="input-closure-from" /></label>
            <label className="rooms-field">Bis (einschließlich)<input required type="date" min={form.fromDate || undefined} value={form.toDate} onChange={event => setForm({ ...form, toDate: event.target.value })} data-testid="input-closure-to" /></label></div>
          <label className="rooms-field">Grund der Sperrung<textarea required maxLength={500} value={form.reason} onChange={event => setForm({ ...form, reason: event.target.value })} placeholder="Warum ist der Raum nicht verfügbar?" data-testid="input-closure-reason" /></label>
          <p className="rooms-form-note">Beide Daten zählen mit. Nach dem Anlegen kannst du betroffene Kurse und verfügbare Alternativen prüfen.</p>
          {formError && <div className="rooms-alert" role="alert" data-testid="error-closure">{formError}</div>}
          <div className="rooms-form-actions"><button type="button" className="rooms-action" onClick={() => setFormOpen(false)} data-testid="button-close-closure-form">Schließen</button><button type="submit" className="rooms-action primary" disabled={createClosure.isPending || !rooms.data?.length} data-testid="button-save-closure">{createClosure.isPending ? 'Wird angelegt …' : 'Sperrung anlegen'}</button></div>
        </form>}
        {closures.isLoading ? <><div className="rooms-skeleton" /><div className="rooms-skeleton" /></> : closures.isError ? <div className="rooms-alert" role="alert">Sperrungen konnten nicht geladen werden. {errorText(closures.error)} <button type="button" className="rooms-action" onClick={() => closures.refetch()} data-testid="button-retry-closures">Erneut laden</button></div>
          : closures.data?.length ? <div className="rooms-closure-list">
            {targetClosureId && !closures.data.some(closure => closure.id === targetClosureId) && <div className="rooms-alert" role="status" data-testid="status-closure-not-found">Diese Sperrung ist im ausgewählten Studio nicht zu sehen. {district ? 'Bitte wähle das zugehörige Studio oben aus.' : 'Sie wurde möglicherweise entfernt.'}</div>}
            {closures.data.map(closure => <ClosureCard key={`${studioId}-${closure.id}`} closure={closure} studioId={studioId} initiallyOpen={closure.id === newClosureId || closure.id === targetClosureId} deleting={deleteClosure.isPending} onDelete={target => { setDeleteTarget(target); setDeleteError(''); }} />)}</div>
          : <div className="rooms-empty"><AlertTriangle size={19} /><p>{targetClosureId ? `Die verlinkte Sperrung ist in diesem Studio nicht zu sehen. ${district ? 'Bitte wähle das zugehörige Studio oben aus.' : 'Sie wurde möglicherweise entfernt.'}` : 'Keine Raumsperrungen eingetragen. Wenn ein Raum ausfällt, halte Zeitraum, Grund und Verantwortung hier fest.'}</p></div>}
      </section></div></>}
    {deleteTarget && <div className="rooms-confirm-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !deleteClosure.isPending) setDeleteTarget(null); }}><div className="rooms-confirm" role="alertdialog" aria-modal="true" aria-labelledby="delete-closure-title" aria-describedby="delete-closure-description"><h2 id="delete-closure-title">Sperrung löschen?</h2><p id="delete-closure-description">Die Sperrung von {deleteTarget.roomName} vom {formatDate(deleteTarget.fromDate)} bis {formatDate(deleteTarget.toDate)} wird entfernt. Bereits abgesagte oder verlegte Kurse werden dadurch nicht rückgängig gemacht.</p>{deleteError && <div className="rooms-alert" role="alert">{deleteError}</div>}<div className="rooms-confirm-actions"><button type="button" className="rooms-action" onClick={() => setDeleteTarget(null)} disabled={deleteClosure.isPending} data-testid="button-dismiss-delete-closure">Zurück</button><button type="button" className="rooms-action danger" onClick={removeClosure} disabled={deleteClosure.isPending} data-testid="button-confirm-delete-closure">{deleteClosure.isPending ? 'Wird gelöscht …' : 'Sperrung löschen'}</button></div></div></div>}
  </div>;
}