import { useState } from 'react';
import type { FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowRight, Bell, CalendarDays, Check, ChevronDown, Clock3, Info, Plus, RefreshCw, ShieldCheck, UserRound, Users, X } from 'lucide-react';
import {
  getGetDashboardQueryKey, getListCoursesQueryKey, getListMemberCoursesQueryKey, getListMemberNotificationsQueryKey,
  getListPulseQueryKey, getListTrainerAbsencesQueryKey, getListTrainerReplacementCandidatesQueryKey, getListStudiosQueryKey,
  useCreateTrainerAbsence, useListCourses, useListStudios, useListTrainerAbsences, useListTrainerReplacementCandidates,
  useRequestTrainerReplacement, useResolveTrainerAbsenceCourse, useRetryTrainerAbsencePush,
} from '@workspace/api-client-react';
import type { Me, TrainerAbsence, TrainerAbsenceCourse } from '@workspace/api-client-react';
import './TrainerAbsencesPage.css';

function errorText(error: unknown) {
  if (error && typeof error === 'object') {
    const value = error as { data?: unknown; message?: string; status?: number };
    if (value.data && typeof value.data === 'object') {
      const body = value.data as { error?: unknown; message?: unknown };
      if (typeof body.error === 'string') return body.error;
      if (typeof body.message === 'string') return body.message;
    }
    if (typeof value.data === 'string') return value.data;
    if (value.status === 409) return 'Der Kurs wurde zwischenzeitlich geändert. Bitte lade die Übersicht neu.';
    if (value.message && !value.message.startsWith('Request failed')) return value.message;
  }
  return 'Die Aktion konnte nicht abgeschlossen werden. Bitte versuche es erneut.';
}

function dateLabel(value: string) {
  const [year, month, day] = value.slice(0, 10).split('-');
  return year && month && day ? `${day}.${month}.${year}` : value;
}

function slotLabel(start: string, end: string) {
  const from = new Date(start);
  const to = new Date(end);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return start;
  return `${new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: 'short' }).format(from)} · ${new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(from)}–${new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(to)} Uhr`;
}

function initials(value: string) {
  return value.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join('');
}

function invalidateChanges(client: ReturnType<typeof useQueryClient>) {
  void client.invalidateQueries({ queryKey: getListTrainerAbsencesQueryKey() });
  void client.invalidateQueries({ queryKey: getListCoursesQueryKey() });
  void client.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
  void client.invalidateQueries({ queryKey: getListMemberCoursesQueryKey() });
  void client.invalidateQueries({ queryKey: getListMemberNotificationsQueryKey() });
  void client.invalidateQueries({ queryKey: getListPulseQueryKey() });
}

const statusLabels: Record<TrainerAbsenceCourse['status'], string> = {
  open: 'Entscheidung offen', requested: 'Anfrage notiert', replaced: 'Vertretung bestätigt',
  cancelled: 'Abgesagt', external: 'Extern besetzt',
};

function CourseCard({ absenceId, course }: { absenceId: number; course: TrainerAbsenceCourse }) {
  const client = useQueryClient();
  const [panel, setPanel] = useState<'candidates' | 'external' | null>(null);
  const [externalName, setExternalName] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const candidates = useListTrainerReplacementCandidates(absenceId, course.courseId, {
    query: {
      enabled: panel === 'candidates' && course.status === 'open',
      queryKey: getListTrainerReplacementCandidatesQueryKey(absenceId, course.courseId),
    },
  });
  const request = useRequestTrainerReplacement();
  const resolve = useResolveTrainerAbsenceCourse();
  const retryPush = useRetryTrainerAbsencePush();
  const busy = request.isPending || resolve.isPending || retryPush.isPending;
  const resolved = course.status === 'replaced' || course.status === 'cancelled' || course.status === 'external';

  function requestCandidate(name: string) {
    setError(''); setSuccess('');
    request.mutate({ id: absenceId, courseId: course.courseId, data: { candidateName: name } }, {
      onSuccess: () => {
        setPanel(null);
        setSuccess(`Anfrage an ${name} notiert. Kontaktiere die Person außerhalb von Fiudia und bestätige erst nach ihrer Zusage.`);
        invalidateChanges(client);
      },
      onError: issue => setError(errorText(issue)),
    });
  }

  function decide(action: 'replace' | 'cancel' | 'external') {
    setError(''); setSuccess('');
    if (action === 'cancel' && !confirmCancel) { setConfirmCancel(true); return; }
    if (action === 'replace' && !course.candidateName) {
      setError('Bitte zuerst eine Trainerperson anfragen.'); return;
    }
    if (action === 'external' && externalName.trim().length < 2) {
      setError('Bitte gib den Namen der externen Vertretung ein.'); return;
    }
    resolve.mutate({
      id: absenceId, courseId: course.courseId,
      data: action === 'external' ? { action, externalName: externalName.trim() }
        : action === 'replace' ? { action, candidateName: course.candidateName! } : { action },
    }, {
      onSuccess: () => {
        setConfirmCancel(false); setPanel(null);
        setSuccess(action === 'replace' ? 'Vertretung bestätigt. Gebuchte Mitglieder werden über die Änderung informiert.'
          : action === 'cancel' ? 'Kurs abgesagt. Gebuchte Mitglieder werden über die Absage informiert.'
            : 'Externe Vertretung eingetragen. Gebuchte Mitglieder werden über die Änderung informiert.');
        invalidateChanges(client);
      },
      onError: issue => setError(errorText(issue)),
    });
  }

  function retry() {
    setError(''); setSuccess('');
    retryPush.mutate({ id: absenceId, courseId: course.courseId }, {
      onSuccess: () => { setSuccess('Push-Zustellungen wurden erneut angestoßen. In-App-Hinweise bleiben davon unberührt.'); invalidateChanges(client); },
      onError: issue => setError(errorText(issue)),
    });
  }

  return <article className="ta-course" data-testid={`card-absence-course-${course.id}`}>
    <div className="ta-course-head">
      <div>
        <h3 data-testid={`text-absence-course-title-${course.id}`}>{course.title}</h3>
        <div className="ta-course-detail">
          <span><CalendarDays size={13} />{slotLabel(course.startsAt, course.endsAt)}</span>
          <span><Users size={13} />{course.bookingCount} {course.bookingCount === 1 ? 'Buchung' : 'Buchungen'}</span>
        </div>
      </div>
      <span className={`ta-status ${course.status}`} data-testid={`status-absence-course-${course.id}`}>{statusLabels[course.status]}</span>
    </div>
    <div className="ta-course-foot">
      <p>
        {course.status === 'requested' ? <>Angefragt: <strong>{course.candidateName}</strong> · Zusage noch nicht bestätigt</>
          : course.status === 'replaced' || course.status === 'external' ? <>Jetzt mit <strong>{course.instructor}</strong> · ursprünglich {course.originalInstructor}</>
            : course.status === 'cancelled' ? 'Dieser Termin findet nicht statt.'
              : <>Ursprünglich mit <strong>{course.originalInstructor}</strong></>}
      </p>
      {!resolved && <div className="ta-course-actions">
        {course.status === 'open' && <button type="button" className="ta-btn" aria-expanded={panel === 'candidates'} onClick={() => { setPanel(panel === 'candidates' ? null : 'candidates'); setError(''); }} disabled={busy} data-testid={`button-candidates-${course.id}`}><UserRound size={14} /> Vertretung finden</button>}
        {course.status === 'requested' && <button type="button" className="ta-btn primary" onClick={() => decide('replace')} disabled={busy} data-testid={`button-confirm-replacement-${course.id}`}><Check size={14} /> {resolve.isPending ? 'Wird bestätigt …' : 'Zusage bestätigen'}</button>}
        <button type="button" className="ta-btn" aria-expanded={panel === 'external'} onClick={() => { setPanel(panel === 'external' ? null : 'external'); setError(''); }} disabled={busy} data-testid={`button-external-${course.id}`}>Extern besetzen</button>
        <button type="button" className="ta-btn danger" onClick={() => decide('cancel')} disabled={busy} data-testid={`button-cancel-absence-course-${course.id}`}>Absagen</button>
      </div>}
    </div>
    {panel === 'candidates' && course.status === 'open' && <div className="ta-action-panel">
      <div className="ta-action-title"><strong>Trainer im selben Studio</strong><button type="button" className="ta-close" aria-label="Kandidaten schließen" onClick={() => setPanel(null)} data-testid={`button-close-candidates-${course.id}`}><X size={16} /></button></div>
      <p>Prüfe die Verfügbarkeit hier. Die Anfrage erfolgt außerhalb von Fiudia; du dokumentierst sie anschließend selbst.</p>
      {candidates.isLoading ? <div className="ta-skeleton" aria-label="Kandidaten werden geladen" /> : candidates.isError
        ? <div className="ta-error" role="alert">Kandidaten konnten nicht geladen werden. {errorText(candidates.error)} <button type="button" className="ta-btn" onClick={() => void candidates.refetch()} data-testid={`button-retry-candidates-${course.id}`}>Erneut laden</button></div>
          : candidates.data?.length ? <div className="ta-candidates">{candidates.data.map((candidate, index) => <div key={`${candidate.name}-${index}`} className={`ta-candidate ${candidate.available ? 'available' : ''}`} data-testid={`row-candidate-${course.id}-${index}`}>
            <div><strong>{candidate.name}</strong><small>{candidate.available ? 'Im Studio verfügbar · persönlich anfragen' : candidate.reason || 'Für diesen Termin nicht verfügbar'}</small></div>
            {candidate.available && <button type="button" className="ta-btn" disabled={busy} onClick={() => requestCandidate(candidate.name)} data-testid={`button-request-candidate-${course.id}-${index}`}>{request.isPending ? 'Wird notiert …' : 'Anfrage notieren'} <ArrowRight size={13} /></button>}
          </div>)}</div> : <div className="ta-empty"><UserRound size={20} /><strong>Keine Kandidaten gefunden</strong><p>Du kannst eine externe Vertretung eintragen oder den Kurs absagen.</p></div>}
    </div>}
    {panel === 'external' && !resolved && <div className="ta-action-panel">
      <div className="ta-action-title"><strong>Externe Vertretung eintragen</strong><button type="button" className="ta-close" aria-label="Eingabe schließen" onClick={() => setPanel(null)} data-testid={`button-close-external-${course.id}`}><X size={16} /></button></div>
      <p>Trage den Namen erst ein, wenn die externe Person zugesagt hat. Fiudia kontaktiert sie nicht.</p>
      <label className="ta-field">Name der bestätigten Vertretung<input value={externalName} onChange={event => { setExternalName(event.target.value); setError(''); }} maxLength={120} placeholder="Vor- und Nachname" data-testid={`input-external-name-${course.id}`} /></label>
      <div className="ta-panel-actions"><button type="button" className="ta-btn primary" disabled={busy || externalName.trim().length < 2} onClick={() => decide('external')} data-testid={`button-save-external-${course.id}`}>{resolve.isPending ? 'Wird gespeichert …' : 'Externe Vertretung bestätigen'} <ArrowRight size={14} /></button></div>
    </div>}
    {resolved && <div className="ta-course-detail" style={{ marginTop: 13 }} data-testid={`status-push-${course.id}`}><Bell size={13} /> Mitglieder: In-App-Hinweis erfasst · Push: {course.pushSent} gesendet, {course.pushFailed} fehlgeschlagen, {course.pushPending} ausstehend
      {(course.pushFailed > 0 || course.pushPending > 0) && <button type="button" className="ta-btn" disabled={busy} onClick={retry} data-testid={`button-retry-absence-push-${course.id}`}><RefreshCw size={13} />{retryPush.isPending ? 'Wird erneut versucht …' : 'Push erneut versuchen'}</button>}
    </div>}
    {error && <div className="ta-error" role="alert" style={{ marginTop: 12 }} data-testid={`error-absence-course-${course.id}`}>{error}</div>}
    {success && <div className="ta-success" role="status" style={{ marginTop: 12 }} data-testid={`status-absence-action-${course.id}`}>{success}</div>}
    {confirmCancel && <div className="ta-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setConfirmCancel(false); }}>
      <div className="ta-modal" role="alertdialog" aria-modal="true" aria-labelledby={`ta-cancel-title-${course.id}`} aria-describedby={`ta-cancel-desc-${course.id}`}>
        <div className="ta-eyebrow">Verbindliche Entscheidung</div>
        <h2 id={`ta-cancel-title-${course.id}`}>Diesen Kurs absagen?</h2>
        <p id={`ta-cancel-desc-${course.id}`}>„{course.title}“ am {slotLabel(course.startsAt, course.endsAt)} findet dann nicht statt. {course.bookingCount} gebuchte {course.bookingCount === 1 ? 'Person erhält' : 'Personen erhalten'} einen In-App-Hinweis; Push wird versucht, wo verfügbar.</p>
        {error && <div className="ta-error" role="alert" style={{ marginTop: 14 }}>{error}</div>}
        <div className="ta-modal-actions"><button type="button" className="ta-btn" disabled={busy} onClick={() => { setConfirmCancel(false); setError(''); }} data-testid={`button-keep-absence-course-${course.id}`}>Zurück</button><button type="button" className="ta-btn danger" disabled={busy} onClick={() => decide('cancel')} data-testid={`button-confirm-cancel-absence-course-${course.id}`}>{resolve.isPending ? 'Wird abgesagt …' : 'Kurs verbindlich absagen'}</button></div>
      </div>
    </div>}
  </article>;
}

function AbsenceCard({ absence, initiallyOpen }: { absence: TrainerAbsence; initiallyOpen: boolean }) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  const remaining = absence.courses.filter(course => course.status === 'open' || course.status === 'requested').length;
  return <article className="ta-absence" data-testid={`card-trainer-absence-${absence.id}`}>
    <button type="button" className="ta-absence-head" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} data-testid={`button-expand-absence-${absence.id}`}>
      <div className="ta-person"><span className="ta-avatar">{initials(absence.instructor)}</span><span><strong>{absence.instructor}</strong><small>{absence.studioName} · {dateLabel(absence.fromDate)} – {dateLabel(absence.toDate)}</small></span></div>
      <div className="ta-absence-meta"><span className={`ta-progress ${remaining === 0 ? 'done' : ''}`} data-testid={`status-absence-progress-${absence.id}`}>{remaining === 0 ? 'Alles geklärt' : `${remaining} ${remaining === 1 ? 'Kurs' : 'Kurse'} offen`}</span><ChevronDown size={17} className={`ta-chevron ${expanded ? 'open' : ''}`} /></div>
    </button>
    {expanded && <div className="ta-absence-body"><div className="ta-section-label"><span>Betroffene Kurse</span><span>{absence.courses.length} insgesamt</span></div>
      {absence.courses.length ? <div className="ta-courses">{absence.courses.map(course => <CourseCard key={course.id} absenceId={absence.id} course={course} />)}</div>
        : <div className="ta-empty"><CalendarDays size={20} /><strong>Keine Kurse betroffen</strong><p>Für diese Person sind im gewählten Zeitraum keine passenden Kurse geplant.</p></div>}
    </div>}
  </article>;
}

export default function TrainerAbsencesPage({ me }: { me: Me }) {
  const client = useQueryClient();
  const district = me.role === 'district_manager';
  const studios = useListStudios({ query: { enabled: district, queryKey: getListStudiosQueryKey() } });
  const courses = useListCourses({ query: { queryKey: getListCoursesQueryKey() } });
  const absences = useListTrainerAbsences({ query: { queryKey: getListTrainerAbsencesQueryKey(), refetchInterval: 20000 } });
  const create = useCreateTrainerAbsence();
  const [selectedStudio, setSelectedStudio] = useState<number | null>(null);
  const [instructor, setInstructor] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [newId, setNewId] = useState<number | null>(null);
  const studioId = district ? (selectedStudio ?? studios.data?.[0]?.id ?? 0) : (me.studioId ?? 0);
  const suggestions = [...new Set((courses.data || []).filter(course => course.studioId === studioId).map(course => course.instructor.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const visible = (absences.data || []).filter(absence => absence.studioId === studioId);
  const openCount = visible.reduce((total, absence) => total + absence.courses.filter(course => course.status === 'open' || course.status === 'requested').length, 0);
  const affectedCount = visible.reduce((total, absence) => total + absence.courses.length, 0);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setSuccess('');
    if (!studioId) { setError('Bitte wähle zuerst ein Studio aus.'); return; }
    if (instructor.trim().length < 2) { setError('Bitte gib den Namen der abwesenden Person ein.'); return; }
    if (!fromDate || !toDate || toDate < fromDate) { setError('Bitte wähle einen gültigen Zeitraum einschließlich Start- und Enddatum.'); return; }
    create.mutate({ data: { studioId, instructor: instructor.trim(), fromDate, toDate } }, {
      onSuccess: created => {
        setNewId(created.id); setInstructor(''); setFromDate(''); setToDate('');
        setSuccess(`Abwesenheit für ${created.instructor} erfasst. ${created.courses.length} ${created.courses.length === 1 ? 'Kurs ist' : 'Kurse sind'} betroffen. Ein Hinweis für die Studioleitung wurde in Pulse erstellt.`);
        invalidateChanges(client);
      },
      onError: issue => setError(errorText(issue)),
    });
  }

  if (me.role !== 'district_manager' && me.role !== 'studio_manager') return <div className="ta-page"><div className="ta-empty"><ShieldCheck size={24} /><strong>Nur für Studioleitungen</strong><p>Trainerabsenzen und Kursentscheidungen werden von der zuständigen Leitung verwaltet.</p></div></div>;

  return <div className="ta-page">
    <header className="ta-hero"><div><div className="ta-eyebrow">Team / Planungssicherheit</div><h1>Trainerabsenzen</h1><p>Wenn jemand ausfällt, bleibt der nächste Schritt klar. Erfasse die Abwesenheit, prüfe jeden betroffenen Kurs und dokumentiere deine Entscheidung.</p></div><div className="ta-hero-mark"><ShieldCheck size={16} /> Nur für die Leitung</div></header>
    <div className="ta-overview" aria-label="Übersicht Trainerabsenzen">
      <div className="ta-stat"><strong data-testid="text-absence-count">{absences.isLoading ? '–' : visible.length}</strong><span>erfasste<br />Abwesenheiten</span></div>
      <div className="ta-stat is-urgent"><strong data-testid="text-absence-open-count">{absences.isLoading ? '–' : openCount}</strong><span>Kurse brauchen<br />eine Entscheidung</span></div>
      <div className="ta-stat"><strong data-testid="text-absence-affected-count">{absences.isLoading ? '–' : affectedCount}</strong><span>betroffene<br />Kurstermine</span></div>
    </div>
    <div className="ta-workspace">
      <section className="ta-intake" aria-labelledby="ta-intake-title">
        <div className="ta-intake-top"><div className="ta-intake-kicker"><Plus size={15} /> Neue Meldung</div><h2 id="ta-intake-title">Ausfall erfassen</h2><p>Ein Name, ein Studio, ein Zeitraum. Die betroffenen Termine werden automatisch zugeordnet.</p></div>
        <form className="ta-form" onSubmit={submit}>
          {district && <label className="ta-field">Studio<select value={studioId || ''} onChange={event => { setSelectedStudio(Number(event.target.value)); setSuccess(''); setNewId(null); }} disabled={studios.isLoading} data-testid="select-absence-studio">
            {studios.data?.map(studio => <option key={studio.id} value={studio.id}>{studio.name} · {studio.city}</option>)}
          </select></label>}
          {district && studios.isError && <div className="ta-error" role="alert">Studios konnten nicht geladen werden. <button type="button" className="ta-btn" onClick={() => void studios.refetch()} data-testid="button-retry-absence-studios">Erneut laden</button></div>}
          <label className="ta-field">Abwesende Person<input value={instructor} onChange={event => setInstructor(event.target.value)} list="ta-instructor-options" maxLength={120} placeholder="Name der Kursleitung" required minLength={2} autoComplete="off" data-testid="input-absence-instructor" /><datalist id="ta-instructor-options">{suggestions.map(name => <option key={name} value={name} />)}</datalist></label>
          {courses.isError && <div className="ta-error" role="alert">Namensvorschläge sind nicht verfügbar. Du kannst den Namen trotzdem eingeben. <button type="button" className="ta-btn" onClick={() => void courses.refetch()} data-testid="button-retry-instructor-suggestions">Erneut laden</button></div>}
          <div className="ta-date-grid"><label className="ta-field">Von<input type="date" value={fromDate} onChange={event => { setFromDate(event.target.value); if (toDate && event.target.value > toDate) setToDate(event.target.value); }} required data-testid="input-absence-from" /></label><label className="ta-field">Bis einschließlich<input type="date" value={toDate} min={fromDate || undefined} onChange={event => setToDate(event.target.value)} required data-testid="input-absence-to" /></label></div>
          <div className="ta-form-note"><Info size={15} /><span>Beide Kalendertage zählen. Die Meldung erzeugt einen managerinternen Pulse-Hinweis; Mitglieder werden erst nach einer Kursentscheidung informiert.</span></div>
          {error && <div className="ta-error" role="alert" data-testid="error-create-absence">{error}</div>}
          {success && <div className="ta-success" role="status" data-testid="status-create-absence">{success}</div>}
          <button className="ta-btn primary wide" type="submit" disabled={create.isPending || !studioId} data-testid="button-create-absence">{create.isPending ? 'Abwesenheit wird erfasst …' : 'Abwesenheit erfassen'} <ArrowRight size={15} /></button>
        </form>
      </section>
      <section className="ta-list" aria-labelledby="ta-list-title"><div className="ta-list-head"><div><h2 id="ta-list-title">Laufende Übersicht</h2><p>Jeder betroffene Kurs braucht eine eigene Entscheidung.</p></div><span className="ta-count">{absences.isLoading ? '–' : visible.length}</span></div>
        {absences.isLoading ? <div className="ta-ledger" aria-label="Abwesenheiten werden geladen"><div className="ta-skeleton" /><div className="ta-skeleton" /></div>
          : absences.isError ? <div className="ta-error" role="alert" data-testid="error-list-absences"><AlertCircle size={15} /> Abwesenheiten konnten nicht geladen werden. {errorText(absences.error)} <button type="button" className="ta-btn" onClick={() => void absences.refetch()} data-testid="button-retry-absences">Erneut laden</button></div>
            : visible.length ? <div className="ta-ledger">{visible.map((absence, index) => <AbsenceCard key={absence.id} absence={absence} initiallyOpen={absence.id === newId || (index === 0 && newId === null)} />)}</div>
              : <div className="ta-empty" data-testid="status-absences-empty"><Clock3 size={24} /><strong>Der Kursplan ist ungestört.</strong><p>Noch keine Trainerabsenz für dieses Studio erfasst. Wenn sich das ändert, startest du links mit einer Meldung.</p></div>}
      </section>
    </div>
  </div>;
}