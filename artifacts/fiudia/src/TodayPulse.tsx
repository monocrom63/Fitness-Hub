import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowRight, Bell, CalendarDays, Check, CircleHelp, Clock3, Mail, Pencil, Plus, Search, Trash2, Users, X } from 'lucide-react';
import { Link, useLocation, useSearch } from 'wouter';
import {
  getGetDashboardQueryKey, getListPulseHistoryQueryKey, getListPulseQueryKey, getListStudiosQueryKey, listPulse, useCreatePulseMessage,
  useGetDashboard, useListPulse, useListStudios, useMarkPulseRead, useRetractPulseMessage, useUpdatePulseMessage,
} from '@workspace/api-client-react';
import type { Me, ModuleKey, ModuleSetting, PulseAudience, PulseMessage, PulsePriority } from '@workspace/api-client-react';
import { pulseArchiveQueryOptions } from './PulseArchiveQuery';
import { pulseArchiveHref, readPulseArchiveLocation } from './PulseArchiveLocation';
import { PulseHistory } from './PulseHistory';
import { PulseWithdrawn } from './PulseWithdrawn';
import { useStudioScope } from './StudioScope';
import dashboardPhoto from './assets/today-dashboard-pushup.jpg';

const berlin = 'Europe/Berlin';
const berlinDate = new Intl.DateTimeFormat('de-DE', { timeZone: berlin, weekday: 'long', day: 'numeric', month: 'long' });
const berlinTime = new Intl.DateTimeFormat('de-DE', { timeZone: berlin, hour: '2-digit', minute: '2-digit' });
const berlinDay = new Intl.DateTimeFormat('en-CA', { timeZone: berlin, year: 'numeric', month: '2-digit', day: '2-digit' });

function berlinHour(date: Date) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: berlin, hour: '2-digit', hourCycle: 'h23' }).format(date));
}
function daypart(date: Date) {
  const hour = berlinHour(date);
  return hour < 11 ? 'Morgen' : hour < 17 ? 'Tag' : 'Abend';
}
function roleName(me: Me) {
  return me.role === 'district_manager' ? 'Bezirksleitung' : me.role === 'studio_manager' ? 'Studioleitung' : 'Studio-Team';
}
function dateTime(value: string) {
  return new Intl.DateTimeFormat('de-DE', { timeZone: berlin, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
function priorityName(value: PulsePriority) {
  return value === 'urgent' ? 'Dringend' : value === 'important' ? 'Wichtig' : 'Info';
}
function audienceName(value: PulseAudience) {
  return value === 'managers' ? 'Leitung' : value === 'employees' ? 'Studio-Team' : 'Alle';
}
function StatusError({ retry, label = 'Die Daten konnten gerade nicht geladen werden.' }: { retry: () => void; label?: string }) {
  return <div className="empty-state error-state" role="alert"><div className="empty-icon"><CircleHelp size={22} /></div><h3>Das hat nicht geklappt</h3><p>{label}</p><button className="button button-dark" onClick={retry}>Erneut versuchen</button></div>;
}
function Skeleton({ count = 2 }: { count?: number }) {
  return <div className="pulse-skeleton" aria-label="Inhalte werden geladen" role="status">{Array.from({ length: count }, (_, index) => <i key={index} />)}</div>;
}

function enabled(modules: ModuleSetting[], key: ModuleKey) {
  return modules.some(module => module.key === key && module.enabled);
}

export function TodayPage({ me, modules }: { me: Me; modules: ModuleSetting[] }) {
  const { selectedStudioId } = useStudioScope();
  const dashboardParams = me.role === 'district_manager' && selectedStudioId ? { studioId: selectedStudioId } : undefined;
  const dashboard = useGetDashboard(dashboardParams, { query: { queryKey: getGetDashboardQueryKey(dashboardParams), refetchInterval: 60000 } });
  const pulse = useListPulse(undefined, { query: { queryKey: getListPulseQueryKey(), enabled: enabled(modules, 'pulse'), refetchInterval: 60000 } });
  const unreadPulse = useListPulse({ unreadOnly: true }, { query: { queryKey: getListPulseQueryKey({ unreadOnly: true }), enabled: enabled(modules, 'pulse'), refetchInterval: 60000 } });
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 60000); return () => window.clearInterval(timer); }, []);

  if (dashboard.isLoading) return <div className="today-page"><Skeleton count={3} /></div>;
  if (dashboard.isError || !dashboard.data) return <div className="today-page"><StatusError retry={() => dashboard.refetch()} /></div>;

  const data = dashboard.data;
  const part = daypart(now);
  const today = berlinDay.format(now);
  const todaysCourses = enabled(modules, 'courses') ? data.courses.filter(course => berlinDay.format(new Date(course.startsAt)) === today).sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()) : [];
  const upcoming = todaysCourses.find(course => new Date(course.startsAt).getTime() >= now.getTime());
  const unread = unreadPulse.data || [];
  const lead = me.role === 'district_manager'
    ? (part === 'Abend' ? `Was hat sich heute in ${me.studioName || 'deinem Studio'} bewegt?` : `${me.studioName || 'Dein Studio'}. Ein klarer Blick.`)
    : me.role === 'studio_manager'
      ? (part === 'Abend' ? 'Zeit für den Blick auf den Studio-Tag.' : 'Dein Studio ist in Bewegung.')
      : (upcoming ? `Als Nächstes: ${upcoming.title}` : part === 'Abend' ? 'So klingt dein Studio-Tag aus.' : 'Bereit für den Tag im Studio?');
  const detail = me.role === 'district_manager'
    ? 'Kennzahlen und Aktivitäten dieses Studios. Pulse-Nachrichten bleiben organisationsweit sichtbar.'
    : me.role === 'studio_manager'
      ? 'Entwicklungen und Informationen an einem Ort.'
      : upcoming ? `${berlinTime.format(new Date(upcoming.startsAt))} Uhr · ${upcoming.room} · ${upcoming.instructor}` : 'Deine nächsten Schritte für die Schicht.';
  const focusLink = me.role === 'district_manager' && enabled(modules, 'team') ? '/team' : enabled(modules, 'courses') ? '/courses' : enabled(modules, 'members') ? '/members' : enabled(modules, 'pulse') ? '/pulse' : '/settings';
  const visibleActivities = data.activities.filter(item => item.category === 'check_in' ? enabled(modules, 'members') : item.category === 'member' || item.category === 'course' || item.category === 'team' ? enabled(modules, item.category === 'member' ? 'members' : item.category === 'course' ? 'courses' : 'team') : true);
  const visibleMetrics = data.metrics.filter(metric => {
    const label = metric.label.toLocaleLowerCase('de-DE');
    if (/mitglied|check.in/.test(label)) return enabled(modules, 'members');
    if (/kurs|buchung|auslastung/.test(label)) return enabled(modules, 'courses');
    if (/team|einladung/.test(label)) return enabled(modules, 'team');
    return true;
  });

  return <div className="today-page">
    <div className="today-intro"><div><div className="eyebrow">Today / {roleName(me)}{me.studioName ? ` / ${me.studioName}` : ''}</div><h1>Guten {part}, {data.userName || me.userName}.</h1><p>Das ist heute für dich wichtig.</p></div><span className="today-date">{berlinDate.format(now)}</span></div>
    <section className="today-spotlight" aria-label="Dein Fokus heute"><div><div className="eyebrow">{part === 'Morgen' ? 'Der Tag beginnt' : part === 'Tag' ? 'Mitten im Geschehen' : 'Zum Tagesausklang'}</div><h2>{lead}</h2><p>{detail}</p></div><div className="today-spotlight-side">{me.role === 'studio_employee' && upcoming ? <><span>Nächster Kurs</span><strong>{berlinTime.format(new Date(upcoming.startsAt))} Uhr</strong><Link href="/courses">Kursplan öffnen <ArrowRight size={15} /></Link></> : <><span>Dein Arbeitsbereich</span><strong>{me.studioName || 'Studio'}</strong><Link href={focusLink}>{focusLink === '/team' ? 'Team' : focusLink === '/courses' ? 'Kurse' : focusLink === '/members' ? 'Mitglieder' : focusLink === '/pulse' ? 'Pulse' : 'Einstellungen'} öffnen <ArrowRight size={15} /></Link></>}</div><div className="today-spotlight-photo"><img src={dashboardPhoto} alt="" aria-hidden="true" /></div></section>
    {visibleMetrics.length > 0 && <section aria-label="Aktuelle Kennzahlen"><div className="today-section-head"><h2>{me.role === 'studio_employee' ? 'Im Studio' : 'Dein Studio in Zahlen'}</h2><span className="eyebrow">Aktueller Stand</span></div><div className="today-metrics">{visibleMetrics.map((metric, index) => <div className={`today-metric ${metric.tone}`} key={`${metric.label}-${index}`}><span>{metric.label}</span><strong>{metric.value}</strong>{metric.delta && <small>{metric.delta}</small>}</div>)}</div></section>}
    <div className="today-columns">{enabled(modules, 'courses') && <section className="today-column"><div className="today-section-head"><h2>{me.role === 'district_manager' ? 'Kurse im Blick' : 'Heute im Kursplan'}</h2><Link href="/courses">Alle Kurse <ArrowRight size={14} /></Link></div>{todaysCourses.length ? <div className="today-list">{todaysCourses.slice(0, 5).map(course => <div className="today-list-row" key={course.id}><time>{berlinTime.format(new Date(course.startsAt))}</time><div><strong>{course.title}</strong><small>{course.studioName && me.role === 'district_manager' ? `${course.studioName} · ` : ''}{course.instructor} · {course.room}</small></div><span className="pill pill-scheduled">{course.enrolled}/{course.capacity}</span></div>)}</div> : <p className="today-quiet">Für heute sind keine Kurse eingetragen.</p>}</section>}
      <section className="today-column"><div className="today-section-head"><h2>{me.role === 'studio_employee' ? 'Was zuletzt passiert ist' : 'Aktuelles im Arbeitsbereich'}</h2></div>{visibleActivities.length ? <div className="today-list">{visibleActivities.slice(0, 4).map(item => <div className="today-list-row" key={item.id}><span className="today-activity-mark"><Activity size={15} /></span><div><strong>{item.title}</strong><small>{item.description} · {dateTime(item.happenedAt)}</small></div></div>)}</div> : <p className="today-quiet">Noch keine Aktivitäten in deinem Arbeitsbereich.</p>}</section></div>
    {enabled(modules, 'pulse') && <section className="today-pulse"><div className="today-section-head"><h2>Pulse {unread.length > 0 && <span className="pulse-unread" aria-label="Ungelesene Nachrichten vorhanden" />}</h2><Link href="/pulse">Alle Nachrichten <ArrowRight size={14} /></Link></div>{pulse.isLoading || unreadPulse.isLoading ? <Skeleton count={1} /> : pulse.isError || unreadPulse.isError ? <StatusError label="Pulse konnte nicht geladen werden." retry={() => { pulse.refetch(); unreadPulse.refetch(); }} /> : pulse.data?.length ? <div className="today-pulse-items">{[...unread, ...pulse.data.filter(message => !unread.some(item => item.id === message.id))].slice(0, 3).map(message => <Link href={message.isRead ? '/pulse' : '/pulse?filter=unread'} className="today-pulse-item" key={message.id}><small>{!message.isRead && <span className="pulse-unread" />} {priorityName(message.priority)} · {message.studioName || 'Organisation'}</small><strong>{message.title}</strong><small>{message.authorName} · {dateTime(message.createdAt)}</small></Link>)}</div> : <p className="today-quiet">Noch keine Nachrichten für deinen Arbeitsbereich.</p>}</section>}
  </div>;
}

export function PulsePage({ me }: { me: Me }) {
  const client = useQueryClient();
  const [, setLocation] = useLocation();
  const search = useSearch();
  const composeRequested = new URLSearchParams(search).get('compose') === '1';
  const { filter, searchTerm } = readPulseArchiveLocation(search);
  const [searchInput, setSearchInput] = useState(searchTerm);
  useEffect(() => setSearchInput(searchTerm), [searchTerm]);
  const setFilter = (next: 'all' | 'unread') => setLocation(pulseArchiveHref(search, { filter: next }));
  const applySearch = (term: string) => {
    const normalized = term.trim().slice(0, 120);
    setSearchInput(normalized);
    setLocation(pulseArchiveHref(search, { searchTerm: normalized }));
  };
  const query = useInfiniteQuery(pulseArchiveQueryOptions(filter, searchTerm));
  const create = useCreatePulseMessage();
  const update = useUpdatePulseMessage();
  const retract = useRetractPulseMessage();
  const markRead = useMarkPulseRead();
  const [open, setOpen] = useState(() => composeRequested && me.role !== 'studio_employee');
  const [editing, setEditing] = useState<PulseMessage | null>(null);
  const [historyOpenId, setHistoryOpenId] = useState<number | null>(null);
  const [refreshingConflict, setRefreshingConflict] = useState(false);
  const [conflictRefreshFailed, setConflictRefreshFailed] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', priority: 'info' as PulsePriority, audience: 'all' as PulseAudience, scope: 'organization', studioId: '' });
  const emptyForm = () => ({ title: '', body: '', priority: 'info' as PulsePriority, audience: 'all' as PulseAudience, scope: 'organization', studioId: '' });
  const studios = useListStudios({ query: { queryKey: getListStudiosQueryKey(), enabled: me.role === 'district_manager' && open && form.scope === 'studio' } });
  const selectedStudioValid = !!studios.data?.some(studio => String(studio.id) === form.studioId);
  const editingUnchanged = !!editing && editing.title === form.title.trim() && editing.body === form.body.trim() && editing.priority === form.priority;
  useEffect(() => { if (composeRequested && me.role !== 'studio_employee') setOpen(true); }, [composeRequested, me.role]);
  const close = () => {
    setOpen(false); setEditing(null); setForm(emptyForm());
    if (composeRequested) {
      const params = new URLSearchParams(search);
      params.delete('compose');
      setLocation(`/pulse${params.size ? `?${params}` : ''}`, { replace: true });
    }
  };
  const messages = (query.data?.pages.flat() || []).sort((a, b) => Number(a.isRead) - Number(b.isRead) || b.id - a.id);
  const startEdit = (message: PulseMessage) => {
    update.reset();
    setConflictRefreshFailed(false);
    setEditing(message);
    setForm({ title: message.title, body: message.body, priority: message.priority, audience: message.audience, scope: message.studioId === null ? 'organization' : 'studio', studioId: String(message.studioId ?? '') });
    setOpen(true);
  };
  const reloadCorrection = async () => {
    if (!editing || refreshingConflict) return;
    setRefreshingConflict(true);
    setConflictRefreshFailed(false);
    try {
      // Anchor the page at this notice, independent of search, unread filters,
      // and how many newer messages have arrived since the editor opened.
      const page = await listPulse({ beforeId: editing.id + 1 });
      const current = page.find(message => message.id === editing.id);
      if (!current?.canManage) {
        setConflictRefreshFailed(true);
        return;
      }
      startEdit(current);
      void client.invalidateQueries({ queryKey: getListPulseQueryKey() });
      void client.invalidateQueries({ queryKey: getListPulseHistoryQueryKey(current.id) });
    } catch {
      setConflictRefreshFailed(true);
    } finally {
      setRefreshingConflict(false);
    }
  };
  const publish = (event: React.FormEvent) => {
    event.preventDefault();
    if (refreshingConflict || (editing && update.error?.status === 409)) return;
    if (editing) {
      update.mutate({ id: editing.id, data: { title: form.title.trim(), body: form.body.trim(), priority: form.priority, revision: editing.revision } }, {
        onSuccess: () => { client.invalidateQueries({ queryKey: getListPulseQueryKey() }); client.invalidateQueries({ queryKey: getListPulseHistoryQueryKey(editing.id) }); close(); },
      });
      return;
    }
    const studioId = me.role === 'studio_manager' ? me.studioId ?? null : form.scope === 'organization' ? null : Number(form.studioId);
    if (me.role === 'studio_employee' || (me.role === 'studio_manager' && !me.studioId) || (me.role === 'district_manager' && form.scope === 'studio' && (studios.isLoading || studios.isError || !selectedStudioValid))) return;
    create.mutate({ data: { title: form.title.trim(), body: form.body.trim(), priority: form.priority, audience: form.audience, studioId: studioId ?? null } }, { onSuccess: () => { client.invalidateQueries({ queryKey: getListPulseQueryKey() }); setForm({ title: '', body: '', priority: 'info', audience: 'all', scope: 'organization', studioId: '' }); close(); } });
  };
  const read = (message: PulseMessage) => markRead.mutate(
    { id: message.id, data: { revision: message.revision } },
    {
      onSuccess: () => client.invalidateQueries({ queryKey: getListPulseQueryKey() }),
      onError: error => {
        if (error.status === 409) void client.invalidateQueries({ queryKey: getListPulseQueryKey() });
      },
    },
  );
  const remove = (message: PulseMessage) => {
    if (!window.confirm(`„${message.title}“ für alle Empfänger zurückziehen? Die Nachricht kann danach nicht wiederhergestellt werden.`)) return;
    retract.mutate({ id: message.id }, { onSuccess: () => { client.invalidateQueries({ queryKey: getListPulseQueryKey() }); client.invalidateQueries({ queryKey: getListPulseHistoryQueryKey(message.id) }); } });
  };
  return <div className="pulse-page"><div className="pulse-intro"><div><div className="eyebrow">Fiudia / Zusammenarbeit</div><h1>Pulse.</h1><p>Was dein Team wissen sollte. Nur Nachrichten für deinen Arbeitsbereich.</p></div>{me.role !== 'studio_employee' && <button className="button button-dark" onClick={() => { create.reset(); setEditing(null); setForm(emptyForm()); setOpen(true); }} data-testid="button-create-pulse"><Plus size={17} /> Nachricht verfassen</button>}</div>
    <form className="pulse-search" role="search" onSubmit={event => { event.preventDefault(); applySearch(searchInput); }}>
      <label htmlFor="pulse-search-input">Nachrichten durchsuchen</label>
      <div className="pulse-search-controls"><input id="pulse-search-input" type="search" maxLength={120} value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder="Titel oder Nachrichtentext" data-testid="input-pulse-search" /><button className="button button-dark" type="submit" data-testid="button-pulse-search"><Search size={15} /> Suchen</button>{searchTerm && <button className="button button-outline" type="button" onClick={() => applySearch('')} data-testid="button-clear-pulse-search">Suche löschen</button>}</div>
    </form>
    <div className="pulse-tools"><div className="pulse-tabs" aria-label="Nachrichten filtern"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')} data-testid="button-pulse-all">Alle</button><button className={filter === 'unread' ? 'active' : ''} onClick={() => setFilter('unread')} data-testid="button-pulse-unread">Ungelesen</button></div>{!query.isLoading && !query.isError && <span className="pulse-count">{messages.length} {searchTerm ? 'Treffer' : messages.length === 1 ? 'Nachricht' : 'Nachrichten'} angezeigt{query.hasNextPage ? ' · weitere laden' : ''}</span>}</div>
    {query.isLoading ? <Skeleton count={3} /> : query.isError && !query.data ? <StatusError retry={() => query.refetch()} /> : messages.length ? <div className="pulse-feed">{messages.map(message =>
      <article className={`pulse-card ${message.isRead ? '' : 'unread'}`} key={message.id} data-testid={`pulse-message-${message.id}`}>
        <div className="pulse-card-top"><span className={`pulse-tag ${message.priority}`}>{priorityName(message.priority)}</span><span className="pulse-tag">{audienceName(message.audience)}</span><span className="pulse-tag">{message.studioName || 'Gesamte Organisation'}</span>{message.editedAt && <span className="pulse-tag">Korrigiert</span>}</div>
        <h2>{message.title}</h2><p>{message.body}</p>
        {(me.role === 'studio_manager' || me.role === 'district_manager') && message.roomClosureId != null && <Link href={`/rooms?closure=${message.roomClosureId}${me.role === 'district_manager' && message.studioId != null ? `&studio=${message.studioId}` : ''}`} className="button button-outline" style={{ marginBottom: 14 }} data-testid={`link-pulse-closure-${message.id}`}>Betroffene Kurse bearbeiten <ArrowRight size={15} /></Link>}
        <div className="pulse-card-foot"><span className="pulse-meta">{message.authorName} · {dateTime(message.createdAt)}{message.editedAt ? ` · Korrigiert ${dateTime(message.editedAt)}` : ''} · {message.readCount} {message.readCount === 1 ? 'Lesebestätigung' : 'Lesebestätigungen'}</span>{message.canManage && <span className="pulse-actions"><button type="button" onClick={() => startEdit(message)} aria-label={`Nachricht ${message.title} bearbeiten`}><Pencil size={14} /> Bearbeiten</button><button type="button" onClick={() => remove(message)} disabled={retract.isPending} aria-label={`Nachricht ${message.title} zurückziehen`}><Trash2 size={14} /> Zurückziehen</button></span>}{message.isRead ? <span className="pulse-meta"><Check size={13} style={{ display: 'inline', verticalAlign: 'middle' }} /> Gelesen</span> : <button className="pulse-read-button" onClick={() => read(message)} disabled={markRead.isPending} data-testid={`button-mark-pulse-read-${message.id}`}><Check size={14} /> Als gelesen markieren</button>}</div>
        {me.role !== 'studio_employee' && message.editedAt && <><button className="pulse-history-toggle" type="button" aria-expanded={historyOpenId === message.id} onClick={() => setHistoryOpenId(historyOpenId === message.id ? null : message.id)} data-testid={`button-pulse-history-${message.id}`}>{historyOpenId === message.id ? 'Korrekturverlauf schließen' : 'Korrekturverlauf ansehen'}</button>{historyOpenId === message.id && <PulseHistory messageId={message.id} />}</>}
      </article>)}</div> : <div className="empty-state"><div className="empty-icon"><Bell size={22} /></div><h3>{searchTerm ? 'Keine Treffer' : filter === 'unread' ? 'Alles gelesen' : 'Noch keine Nachrichten'}</h3><p>{searchTerm ? `Für „${searchTerm}“ gibt es ${filter === 'unread' ? 'keine ungelesenen' : 'keine'} Nachrichten in deinem Arbeitsbereich.` : filter === 'unread' ? 'Du bist auf dem aktuellen Stand.' : 'Neue Nachrichten für deinen Arbeitsbereich erscheinen hier.'}</p>{!searchTerm && filter === 'unread' && <button className="button button-outline" onClick={() => setFilter('all')}>Alle Nachrichten ansehen</button>}</div>}
    {query.hasNextPage && <div className="pulse-more"><button className="button button-outline" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? 'Wird geladen …' : 'Ältere Nachrichten laden'}</button></div>}
    {query.isFetchNextPageError && <p className="pulse-form-error" role="alert">Ältere Nachrichten konnten nicht geladen werden. <button onClick={() => query.fetchNextPage()}>Erneut versuchen</button></p>}
    {markRead.isError && <p className="pulse-form-error" role="alert">{markRead.error?.status === 409 ? 'Diese Nachricht wurde inzwischen korrigiert. Die aktuelle Fassung wurde geladen und ist wieder ungelesen.' : 'Lesebestätigung fehlgeschlagen. Bitte versuche es erneut.'}</p>}
    {retract.isError && <p className="pulse-form-error" role="alert">Nachricht konnte nicht zurückgezogen werden. Bitte versuche es erneut.</p>}
    {me.role !== 'studio_employee' && <PulseWithdrawn />}
    {open && <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pulse-compose-title">
        <div className="modal-head"><div><div className="eyebrow">Pulse / {editing ? 'Korrektur' : 'Neue Nachricht'}</div><h2 id="pulse-compose-title">{editing ? 'Nachricht korrigieren' : 'Team informieren'}</h2></div><button className="icon-button" disabled={refreshingConflict} onClick={close} aria-label="Schließen" data-testid="button-close-pulse"><X size={18} /></button></div>
        <form className="pulse-compose" onSubmit={publish}>
          <label className="field">Titel<input disabled={refreshingConflict} required minLength={2} maxLength={140} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} placeholder="Worum geht es?" data-testid="input-pulse-title" /></label>
          <label className="field">Nachricht<textarea disabled={refreshingConflict} required maxLength={2000} value={form.body} onChange={event => setForm({ ...form, body: event.target.value })} placeholder="Die Information für dein Team …" data-testid="input-pulse-body" /></label>
          <div className="field-grid"><label className="field">Priorität<select value={form.priority} onChange={event => setForm({ ...form, priority: event.target.value as PulsePriority })} data-testid="select-pulse-priority"><option value="info">Info</option><option value="important">Wichtig</option><option value="urgent">Dringend</option></select></label>{!editing && <label className="field">Empfänger<select value={form.audience} onChange={event => setForm({ ...form, audience: event.target.value as PulseAudience })} data-testid="select-pulse-audience"><option value="all">Alle</option><option value="managers">Leitung</option><option value="employees">Studio-Team</option></select></label>}</div>
          {editing ? <p className="pulse-meta">Empfänger und Studio bleiben unverändert. Bisherige Lesebestätigungen werden für die Korrektur zurückgesetzt.</p> : me.role === 'district_manager' ? <label className="field">Gültigkeitsbereich<select value={form.scope} onChange={event => setForm({ ...form, scope: event.target.value, studioId: '' })} data-testid="select-pulse-scope"><option value="organization">Gesamte Organisation</option><option value="studio">Ein bestimmtes Studio</option></select></label> : <p className="pulse-meta">Studio: {me.studioName || 'Dein Studio'}</p>}
          {!editing && me.role === 'district_manager' && form.scope === 'studio' && (studios.isLoading ? <div className="pulse-studio-status" role="status">Studios werden geladen …</div> : studios.isError ? <div className="pulse-studio-status" role="alert">Studios konnten nicht geladen werden. <button type="button" onClick={() => studios.refetch()} data-testid="button-retry-pulse-studios">Erneut versuchen</button></div> : studios.data?.length ? <label className="field">Studio<select required value={form.studioId} onChange={event => setForm({ ...form, studioId: event.target.value })} data-testid="select-pulse-studio"><option value="">Studio auswählen</option>{studios.data.map(studio => <option key={studio.id} value={studio.id}>{studio.name} · {studio.city}</option>)}</select></label> : <div className="pulse-studio-status" role="status">Keine zugänglichen Studios vorhanden.</div>)}
          {editing && update.error?.status === 409 ? <div className="pulse-form-error" role="alert"><p>Diese Meldung wurde inzwischen von jemand anderem korrigiert. Deine Änderungen wurden nicht gespeichert.</p><button type="button" className="button button-outline" disabled={refreshingConflict} onClick={reloadCorrection}>{refreshingConflict ? 'Wird geladen …' : 'Änderungen verwerfen und aktuelle Fassung prüfen'}</button>{conflictRefreshFailed && <p>Die aktuelle Fassung konnte nicht geladen werden oder ist nicht mehr bearbeitbar. Dein Entwurf bleibt erhalten. Bitte erneut versuchen oder den Editor schließen.</p>}</div>
            : (create.isError || update.isError) && <p className="pulse-form-error" role="alert">Nachricht konnte nicht gespeichert werden. Prüfe die Angaben und versuche es erneut.</p>}
          <button className="button button-dark button-wide" disabled={create.isPending || update.isPending || refreshingConflict || (!!editing && update.error?.status === 409) || editingUnchanged || (!editing && ((me.role === 'studio_manager' && !me.studioId) || (me.role === 'district_manager' && form.scope === 'studio' && (studios.isLoading || studios.isError || !selectedStudioValid))))} data-testid="button-publish-pulse"><Mail size={16} /> {create.isPending || update.isPending ? 'Wird gespeichert …' : editingUnchanged ? 'Keine Änderungen' : editing ? 'Korrektur speichern' : 'Nachricht veröffentlichen'}</button>
        </form>
      </div>
    </div>}
  </div>;
}

export function ActionStrip({ me, modules }: { me: Me; modules: ModuleSetting[] }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 60000); return () => window.clearInterval(timer); }, []);
  const part = daypart(now);
  const manager = me.role !== 'studio_employee';
  const actions = manager
    ? part === 'Abend'
      ? [{ href: '/dashboard', label: 'Tagesstand ansehen', icon: Activity }, { href: '/pulse?compose=1', label: 'Pulse-Nachricht verfassen', icon: Mail }, { href: '/team', label: 'Team öffnen', icon: Users }]
      : [{ href: '/pulse?compose=1', label: 'Pulse-Nachricht verfassen', icon: Mail }, { href: '/courses', label: 'Kurse öffnen', icon: CalendarDays }, { href: '/members', label: 'Mitglieder öffnen', icon: Users }]
    : part === 'Abend'
      ? [{ href: '/dashboard', label: 'Tagesstand ansehen', icon: Activity }, { href: '/pulse', label: 'Pulse lesen', icon: Bell }, { href: '/members', label: 'Check-in-Liste öffnen', icon: Check }]
      : [{ href: '/members', label: 'Check-in-Liste öffnen', icon: Check }, { href: '/courses', label: 'Kursplan öffnen', icon: CalendarDays }, { href: '/pulse', label: 'Pulse lesen', icon: Bell }];
  const available = actions.filter(action => action.href === '/dashboard' || enabled(modules, action.href.split('?')[0].slice(1) as ModuleKey));
  if (!available.length) return null;
  return <div className="action-strip">{open && <nav className="action-strip-menu" aria-label="Schnellaktionen"><span><Clock3 size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> {part === 'Morgen' ? 'Für deinen Morgen' : part === 'Tag' ? 'Für deinen Tag' : 'Für deinen Abend'}</span>{available.map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={() => setOpen(false)} data-testid={`link-action-${href.split('?')[0].slice(1)}`}><Icon size={17} />{label}<ArrowRight size={14} style={{ marginLeft: 'auto' }} /></Link>)}</nav>}<button className="action-strip-trigger" aria-expanded={open} aria-label={open ? 'Schnellaktionen schließen' : 'Schnellaktionen öffnen'} onClick={() => setOpen(value => !value)} data-testid="button-action-strip"><Plus size={19} /> Schnellaktionen</button></div>;
}