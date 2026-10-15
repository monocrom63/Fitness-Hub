import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useInfiniteQuery } from '@tanstack/react-query';
import { ClerkProvider, SignIn, SignUp, UserProfile, useAuth, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/shared/keys';
import { shadcn } from '@clerk/themes';
import { deDE } from '@clerk/localizations';
import { useForm } from 'react-hook-form';
import { Activity, ArrowRight, Bell, CalendarDays, Check, Clock3, DoorOpen, History, Link2, LogOut, MapPin, ShieldCheck, Ticket, Users, UserRound, X } from 'lucide-react';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation, useParams, useSearch } from 'wouter';
import type { Member, MemberCourse, MemberHome, MemberNotification } from '@workspace/api-client-react';
import { getGetMemberCourseQueryKey, unregisterMemberPushSubscription, useCreateMemberBillingCheckout, useGetMemberBilling } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useEmailPreference, useGetMemberHome, useGetMemberCourse, useInvitationAcceptance, useListMemberCheckIns, useListMemberCourses, useMemberActions, useMemberNotificationUnreadCount, useNotificationRead, useOwnMemberProfile } from '@/hooks/use-member';
import { courseDisplayState, courseFilterHref, courseQueryParams, readCourseLocation, type CourseFilter } from './course-target';
import { memberNotificationArchiveQueryOptions } from './notification-history';
import courseBrowsePhoto from './assets/course-cable-pulldown.webp';
import { acceptInvitation, afterAuthPath, clearInvite, enterInvitation, pendingInvitationPath, pendingInvite as getPendingInvite } from './invitation-return';
import { clearCoursePushClickState, getOneSignal, listenForCoursePushClicks, optOutOnSignOut, registerPushSubscription, rememberPushChoice, rememberPushSubscriptionId, storedPushSubscriptionId, supportsPushEnvironment } from './lib/onesignal';
import memberLoginPhoto from './assets/member-login-photo.jpeg';
import memberSignupPhoto from './assets/member-signup-gym.jpg';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxy = import.meta.env.VITE_CLERK_PROXY_URL;
const stripBase = (path: string) => basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
const pendingInvite = () => getPendingInvite(sessionStorage);

// The managed Clerk tenant name is set outside this app. Keep every embedded
// authentication step branded while preserving the rest of the German locale.
function withFiudiaName<T>(value: T): T {
  if (typeof value === 'string') return value.replaceAll('{{applicationName}}', 'Fiudia') as T;
  if (Array.isArray(value)) return value.map(withFiudiaName) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, text]) => [key, withFiudiaName(text)])) as T;
  }
  return value;
}
const germanClerk = withFiudiaName(deDE);
const clerkLocalization = {
  ...germanClerk,
  formFieldInputPlaceholder__signUpPassword: 'Passwort erstellen',
  signIn: {
    ...germanClerk.signIn,
    start: {
      ...germanClerk.signIn?.start,
      title: 'Bei Fiudia anmelden',
      titleCombined: 'Bei Fiudia anmelden',
      subtitle: 'Melde dich bei Fiudia an, um fortzufahren.',
      subtitleCombined: 'Melde dich bei Fiudia an, um fortzufahren.',
    },
  },
  signUp: {
    ...germanClerk.signUp,
    start: {
      ...germanClerk.signUp?.start,
      title: 'Fiudia-Konto erstellen',
      titleCombined: 'Fiudia-Konto erstellen',
      subtitle: 'Registriere dich bei Fiudia und verbinde deine Mitgliedschaft.',
      subtitleCombined: 'Registriere dich bei Fiudia und verbinde deine Mitgliedschaft.',
    },
  },
};

function pageTitle(title: string) {
  document.title = `${title} · Fiudia Mitglieder`;
}
function dayNumber(date: string) { return new Intl.DateTimeFormat('de-DE', { day: '2-digit' }).format(new Date(date)); }
function monthLabel(date: string) { return new Intl.DateTimeFormat('de-DE', { month: 'short' }).format(new Date(date)).replace('.', ''); }
function dateLabel(date: string) { return new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(date)); }
function timeLabel(date: string) { return new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(new Date(date)); }
function initials(name: string) { return name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase(); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Bitte versuche es noch einmal.'; }

function Brand() {
  return <Link href="/" className="logo" data-testid="link-brand"><span className="logo-symbol">F</span><span>Fiudia</span></Link>;
}
function LoadingPage() {
  return <div className="page" data-testid="status-loading"><div className="topline"><span className="eyebrow">Fiudia / Mitglieder</span></div><div className="skeleton-page"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div></div>;
}
function ErrorView({ onRetry, title = 'Das hat nicht geklappt' }: { onRetry: () => void; title?: string }) {
  return <div className="soft-card empty-card" data-testid="status-error"><div className="empty-icon"><Activity size={21} /></div><h3>{title}</h3><p>Deine Daten sind gerade nicht erreichbar. Versuche es bitte gleich noch einmal.</p><button className="button button-primary" type="button" onClick={onRetry} data-testid="button-retry">Erneut versuchen <ArrowRight size={15} /></button></div>;
}
function EmptyView({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="soft-card empty-card" data-testid="status-empty"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{description}</p>{action}</div>;
}
function PageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  useEffect(() => pageTitle(title), [title]);
  return <><div className="topline"><span className="eyebrow">Fiudia / {eyebrow}</span><span className="topline-right"><i /> Dein Raum für Bewegung</span></div><div className="page-head"><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div></>;
}
function MemberShell({ member, home, children }: { member: Member | null; home?: MemberHome; children: ReactNode }) {
  const [location, navigate] = useLocation();
  const { user } = useUser();
  const { signOut } = useClerk();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const leave = () => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError('');
    void Promise.race([
      optOutOnSignOut(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Abmeldung vom Push-Dienst dauert zu lange.')), 5000)),
    ]).then(() => signOut({ redirectUrl: `${window.location.origin}${basePath}/sign-in` }))
      .catch(() => {
        setSignOutError('Push konnte auf diesem Gerät nicht sicher abgemeldet werden. Bitte versuche es erneut.');
        setSigningOut(false);
      });
  };
  const unreadCount = useMemberNotificationUnreadCount(Boolean(member && home?.coursesEnabled));
  useEffect(() => {
    if (!member || !home?.coursesEnabled) return;
    return listenForCoursePushClicks(member.id, target => navigate(target));
  }, [member, home?.coursesEnabled, navigate]);
  const unread = unreadCount.data?.count ?? 0;
  const nav = [
    { href: '/', label: 'Heute', icon: Activity },
    ...(member && home?.coursesEnabled ? [{ href: '/courses', label: 'Kurse', icon: CalendarDays }] : []),
    ...(member && home?.coursesEnabled ? [{ href: '/notifications', label: 'Hinweise', icon: Bell }] : []),
    ...(member && home?.checkInsEnabled ? [{ href: '/check-ins', label: 'Check-ins', icon: History }] : []),
    { href: '/connect', label: 'Mitgliedschaft', icon: Link2 },
    ...(member ? [{ href: '/profile', label: 'Mein Profil', icon: UserRound }] : []),
  ];
  return <div className="app-shell">
    <aside className="rail">
      <Brand />
      <div className="rail-kicker">Mein Fiudia</div>
      <nav className="rail-nav" aria-label="Hauptnavigation">{nav.map(({ href, label, icon: Icon }) => <Link key={href} href={href} className={`rail-link ${location === href ? 'active' : ''}`} data-testid={`link-nav-${href === '/' ? 'today' : href.slice(1)}`}><Icon /><span className="nav-label">{label}</span>{href === '/notifications' && unread > 0 && <span className="unread-badge" aria-label={`${unread} ungelesene Hinweise`} data-testid="status-unread-count">{unread > 99 ? '99+' : unread}</span>}</Link>)}</nav>
      <div className="rail-bottom">
        <div className="rail-note"><div><strong>Dein Tempo zählt.</strong>Ein guter Trainingstag beginnt damit, dass du einfach auftauchst.</div></div>
        <div className="rail-user"><span className="avatar">{initials(member?.fullName || user?.fullName || 'Fiudia')}</span><span>{member?.fullName || user?.fullName || 'Mein Konto'}<small>{member?.studioName || 'Noch kein Studio verbunden'}</small></span><button className="signout" type="button" onClick={leave} disabled={signingOut} aria-label="Abmelden" title="Abmelden" data-testid="button-sign-out"><LogOut size={17} /></button></div>
      </div>
    </aside>
    <div className="main"><div className="mobile-header"><Brand /><button className="signout" type="button" onClick={leave} disabled={signingOut} aria-label="Abmelden" data-testid="button-mobile-sign-out"><LogOut size={18} /></button></div>{signOutError && <p className="form-error" role="alert">{signOutError}</p>}{children}</div>
    <nav className="mobile-nav" aria-label="Mobile Navigation">{nav.map(({ href, label, icon: Icon }) => <Link key={href} href={href} className={location === href ? 'active' : ''} data-testid={`link-mobile-${href === '/' ? 'today' : href.slice(1)}`}><Icon size={19} strokeWidth={1.7} />{label}{href === '/notifications' && unread > 0 && <span className="unread-badge" aria-label={`${unread} ungelesene Hinweise`}>{unread > 99 ? '99+' : unread}</span>}</Link>)}</nav>
  </div>;
}
function MembershipRequired() {
  return <div className="page"><PageHeader eyebrow="Dein Anfang" title="Erst verbinden. Dann los." description="Verknüpfe deine bestehende Mitgliedschaft, um deinen persönlichen Studiobereich zu sehen." /><EmptyView icon={<Link2 size={22} />} title="Dein Studio wartet auf dich" description="Am einfachsten geht es mit dem persönlichen Einladungslink deines Studios. Melde dich mit der bestätigten E-Mail-Adresse an, an die die Einladung geschickt wurde." action={<Link href="/connect" className="button button-primary" data-testid="link-connect-membership">Verbindungsmöglichkeiten <ArrowRight size={15} /></Link>} /></div>;
}
function StatusChip({ course }: { course: MemberCourse }) {
  if (course.bookingStatus === 'confirmed') return <span className="status-chip" data-testid={`status-booking-${course.id}`}><Check size={12} /> Platz gesichert</span>;
  if (course.bookingStatus === 'waitlisted') return <span className="status-chip waitlisted" data-testid={`status-booking-${course.id}`}>Warteliste{course.waitlistPosition != null ? ` · Platz ${course.waitlistPosition}` : ''}</span>;
  return <span className="status-chip none" data-testid={`status-booking-${course.id}`}>{course.enrolled >= course.capacity ? 'Warteliste offen' : `${Math.max(0, course.capacity - course.enrolled)} Plätze frei`}</span>;
}
function TodayPage({ member, home }: { member: Member; home: MemberHome }) {
  const next = home.nextCourse;
  const first = member.fullName.split(' ')[0];
  return <div className="page"><PageHeader eyebrow="Heute" title={`Hallo, ${first}.`} description={`${dateLabel(new Date().toISOString())} · ${member.studioName}. Ein kleiner Blick auf das, was vor dir liegt.`} />
    <div className={`today-grid ${!home.coursesEnabled && !home.checkInsEnabled ? 'no-modules' : ''}`}>
      <div className="hero-panel"><div className="eyebrow">Dein Platz in Bewegung</div><h2>Mach es zu<br /><em>deinem Moment.</em></h2><p>Du musst nicht jeden Tag alles geben. Nur deinen nächsten Schritt machen.</p>{home.coursesEnabled && <div className="hero-panel-foot"><Link href="/courses" className="outline-action" data-testid="link-explore-courses">Kurse entdecken <ArrowRight size={15} /></Link></div>}</div>
      {(home.coursesEnabled || home.checkInsEnabled) && <div className={`stats-stack ${home.coursesEnabled !== home.checkInsEnabled ? 'one-stat' : ''}`}>
        {home.coursesEnabled && <div className="stat-tile"><div className="stat-tile-head">Kommende Buchungen <Ticket size={19} /></div><div className="stat-value" data-testid="text-upcoming-bookings">{home.upcomingBookings}</div><div className="stat-caption">Deine nächsten Momente im Studio</div></div>}
        {home.checkInsEnabled && <div className="stat-tile mint"><div className="stat-tile-head">Deine Check-ins <DoorOpen size={19} /></div><div className="stat-value" data-testid="text-check-in-count">{home.checkInCount}</div><div className="stat-caption">Jedes Mal zählt</div></div>}
      </div>}
    </div>
    {home.coursesEnabled && <><div className="section-head"><div><div className="eyebrow">Was kommt als Nächstes?</div><h2>Dein nächster Kurs</h2></div><Link href="/courses" className="text-link" data-testid="link-all-courses">Alle Kurse <ArrowRight size={15} /></Link></div>
    {next ? <div className="next-card" data-testid="card-next-course"><div className="date-block"><strong>{dayNumber(next.startsAt)}</strong><span>{monthLabel(next.startsAt)}</span></div><div className="next-info"><div className="eyebrow">{timeLabel(next.startsAt)} – {timeLabel(next.endsAt)} Uhr · {next.room}</div><h3 data-testid="text-next-course-title">{next.title}</h3><p>mit {next.instructor} · {next.studioName}</p></div><StatusChip course={next} /></div> :
      <EmptyView icon={<CalendarDays size={22} />} title="Noch nichts im Kalender." description="Der richtige Kurs für dich ist vielleicht nur einen Blick entfernt." action={<Link href="/courses" className="button button-secondary" data-testid="link-find-course">Kurse ansehen <ArrowRight size={15} /></Link>} />}</>}
    <div className="footer-line">Fiudia Mitglieder · Ein Ort für deinen eigenen Rhythmus.</div>
  </div>;
}
function CourseRow({ course, targeted = false, unavailable = false }: { course: MemberCourse; targeted?: boolean; unavailable?: boolean }) {
  const { book, cancel } = useMemberActions();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const booked = course.bookingStatus === 'confirmed' || course.bookingStatus === 'waitlisted';
  const isPast = unavailable || new Date(course.startsAt).getTime() <= Date.now();
  const reserve = async () => {
    setError(''); setMessage('');
    try {
      const result = await book.mutateAsync({ id: course.id });
      setMessage(result.status === 'waitlisted' ? 'Du stehst jetzt auf der Warteliste.' : 'Dein Platz ist gesichert.');
    } catch (failure) { setError(errorMessage(failure)); }
  };
  const remove = async () => {
    setError(''); setMessage('');
    try { await cancel.mutateAsync({ id: course.id }); setConfirmCancel(false); setMessage('Deine Buchung wurde storniert.'); }
    catch (failure) { setError(errorMessage(failure)); }
  };
  return <article id={`course-${course.id}`} tabIndex={-1} className={`course-row${targeted ? ' course-row--targeted' : ''}`} data-testid={`card-course-${course.id}`}>
    <div className="course-day"><strong>{dayNumber(course.startsAt)}</strong><span>{monthLabel(course.startsAt)}</span></div>
    <div className="course-detail"><div className="eyebrow">{new Intl.DateTimeFormat('de-DE', { weekday: 'long' }).format(new Date(course.startsAt))} · {timeLabel(course.startsAt)} – {timeLabel(course.endsAt)} Uhr</div><h3 data-testid={`text-course-title-${course.id}`}>{course.title}</h3><p>mit {course.instructor} · {course.studioName}</p></div>
    <div className="course-meta"><p><MapPin /> {course.room}</p><p><Users /> {course.enrolled} / {course.capacity} Plätze belegt</p></div>
    <div className="course-action">{isPast ? <span className="status-chip none" data-testid={`status-course-past-${course.id}`}>{unavailable ? 'Kurs abgesagt' : new Date(course.endsAt).getTime() <= Date.now() ? 'Vergangener Kurs' : 'Kurs läuft bereits'}</span> : <><StatusChip course={course} />{booked ? <button type="button" className="button button-quiet" onClick={() => setConfirmCancel(true)} disabled={cancel.isPending} data-testid={`button-cancel-course-${course.id}`}>Stornieren</button> : <button type="button" className="button button-primary" onClick={() => { void reserve(); }} disabled={book.isPending} data-testid={`button-book-course-${course.id}`}>{book.isPending ? 'Wird gebucht …' : course.enrolled >= course.capacity ? 'Warteliste' : 'Platz buchen'} <ArrowRight size={14} /></button>}</>}</div>
    {(error || message) && <div className={error ? 'form-error' : 'course-feedback'} role="status" data-testid={`status-course-action-${course.id}`}>{error || message}</div>}
    {confirmCancel && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !cancel.isPending) setConfirmCancel(false); }}><div className="dialog-card" role="alertdialog" aria-modal="true" aria-labelledby={`dialog-title-${course.id}`} aria-describedby={`dialog-description-${course.id}`}><button className="dialog-close" type="button" onClick={() => setConfirmCancel(false)} disabled={cancel.isPending} aria-label="Schließen" data-testid={`button-close-cancel-${course.id}`}><X size={18} /></button><div className="empty-icon"><CalendarDays size={22} /></div><h3 id={`dialog-title-${course.id}`}>Platz freigeben?</h3><p id={`dialog-description-${course.id}`}>Du möchtest deine {course.bookingStatus === 'waitlisted' ? 'Wartelistenposition' : 'Buchung'} für „{course.title}“ am {dateLabel(course.startsAt)} stornieren.</p>{error && <div className="form-error" role="alert">{error}</div>}<div className="dialog-actions"><button type="button" className="button button-quiet" onClick={() => setConfirmCancel(false)} disabled={cancel.isPending} data-testid={`button-keep-course-${course.id}`}>Platz behalten</button><button type="button" className="button button-danger" onClick={() => { void remove(); }} disabled={cancel.isPending} data-testid={`button-confirm-cancel-${course.id}`}>{cancel.isPending ? 'Wird storniert …' : 'Ja, stornieren'}</button></div></div></div>}
  </article>;
}
function CourseDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const courseId = /^[1-9]\d*$/.test(id) ? Number(id) : 0;
  const validId = Number.isInteger(courseId) && courseId > 0 && courseId <= 2147483647;
  const detail = useGetMemberCourse(courseId, { query: { queryKey: getGetMemberCourseQueryKey(courseId), enabled: validId, retry: false } });
  const notFound = !validId || (detail.error && 'status' in detail.error && detail.error.status === 404);
  const course = detail.data;
  return <div className="page">
    <PageHeader eyebrow="Kursdetails" title="Dein Kurs im Überblick." description="Hier findest du den Kurs zu deinem Hinweis – auch nach seinem Ende." />
    <div className="section-head"><Link href="/notifications" className="text-link">Zurück zu den Hinweisen</Link><Link href="/courses" className="text-link">Zum Kursplan</Link></div>
    {notFound ? <EmptyView icon={<CalendarDays size={22} />} title="Kurs nicht verfügbar." description="Dieser Kurs ist nicht mehr vorhanden oder gehört nicht zu deinen zugänglichen Kursen." /> :
      detail.isLoading ? <LoadingPage /> :
      detail.isError ? <ErrorView title="Kurs nicht erreichbar" onRetry={() => { void detail.refetch(); }} /> :
      course ? <>
        <p data-testid="text-course-date">{new Intl.DateTimeFormat('de-DE', { dateStyle: 'full' }).format(new Date(course.startsAt))} · {timeLabel(course.startsAt)} – {timeLabel(course.endsAt)} Uhr · Kurs #{course.id}</p>
        <CourseRow key={course.id} course={course} targeted unavailable={course.status === 'cancelled'} />
        <p data-testid="text-course-booking">{course.bookingStatus === 'confirmed' ? 'Dein Buchungsstatus: bestätigt.' : course.bookingStatus === 'waitlisted' ? `Dein Buchungsstatus: Warteliste, Position ${course.waitlistPosition}.` : 'Keine aktive Buchung für diesen Kurs.'}</p>
      </> : null}
  </div>;
}
export function CoursesPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { targetId, filter } = readCourseLocation(search);
  const courses = useListMemberCourses(courseQueryParams(search));
  const setFilter = (next: CourseFilter) => navigate(courseFilterHref(search, next));
  const { visible, targetVisible, targetExists } = courseDisplayState(courses.data || [], filter, targetId);
  useEffect(() => {
    if (!targetVisible) return;
    const course = document.getElementById(`course-${targetId}`);
    if (course) {
      course.focus({ preventScroll: true });
      course.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [targetId, filter, targetVisible, courses.data]);
  return <div className="page"><PageHeader eyebrow="Kurse" title="Finde deinen Moment." description="Alle kommenden Kurse in deinem Studio. Über deine Hinweise kannst du auch vergangene Kurse wiederfinden." />
    <section className="course-browse-banner" aria-label="Kurse entdecken"><img src={courseBrowsePhoto} alt="" aria-hidden="true" /><div className="course-browse-copy"><div className="eyebrow">Dein Studio · Dein Moment</div><h2>Jede Einheit bringt dich weiter.</h2></div></section>
    {courses.isLoading ? <div className="skeleton-page"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div> : courses.isError ? <ErrorView onRetry={() => { void courses.refetch(); }} /> : <>
      {targetId !== null && !targetExists && <div className="course-feedback" role="status" data-testid="status-course-unavailable">Dieser Kurs ist für dich nicht verfügbar.</div>}
      {targetExists && !targetVisible && <div className="course-feedback" role="status" data-testid="status-course-filtered">Dieser Kurs ist nicht unter „Meine Plätze“ zu finden. <button type="button" className="text-link" onClick={() => setFilter('all')} data-testid="button-show-target-course">Alle Kurse ansehen</button></div>}
      <div className="course-toolbar"><div className="filter-group" role="group" aria-label="Kurse filtern"><button type="button" className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')} data-testid="button-filter-all">Alle Kurse</button><button type="button" className={filter === 'mine' ? 'selected' : ''} onClick={() => setFilter('mine')} data-testid="button-filter-mine">Meine Plätze</button></div><span data-testid="text-course-count">{visible.length} {visible.length === 1 ? 'Kurs' : 'Kurse'}</span></div>
      {visible.length ? <div className="course-list">{visible.map(course => <CourseRow key={course.id} course={course} targeted={course.id === targetId} />)}</div> : <EmptyView icon={<CalendarDays size={22} />} title={filter === 'mine' ? 'Noch kein Platz gebucht.' : 'Gerade keine Kurse geplant.'} description={filter === 'mine' ? 'Schau dich im Kursplan um und sichere dir deinen ersten Platz.' : 'Dein Studio hat im Moment keine kommenden Kurse eingetragen.'} action={filter === 'mine' ? <button type="button" className="button button-secondary" onClick={() => setFilter('all')} data-testid="button-show-all-courses">Alle Kurse ansehen <ArrowRight size={15} /></button> : undefined} />}
    </>}
    <div className="footer-line">Dein Kursplan · {new Date().getFullYear()} Fiudia</div>
  </div>;
}
function CheckInsPage() {
  const checkIns = useListMemberCheckIns();
  const sorted = [...(checkIns.data || [])].sort((a, b) => new Date(b.checkedInAt).getTime() - new Date(a.checkedInAt).getTime());
  return <div className="page"><PageHeader eyebrow="Check-ins" title="Du warst da." description="Jeder Besuch ist ein Schritt. Hier findest du deine persönliche Studio-Historie." />
    {checkIns.isLoading ? <div className="skeleton-page"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div> : checkIns.isError ? <ErrorView onRetry={() => { void checkIns.refetch(); }} /> : sorted.length ? <><div className="course-toolbar"><span data-testid="text-check-in-total">{sorted.length} {sorted.length === 1 ? 'Besuch' : 'Besuche'} insgesamt</span></div><div className="history-list">{sorted.map((item) => <div className="history-item" key={item.id} data-testid={`row-check-in-${item.id}`}><div className="history-icon"><Check size={19} strokeWidth={2} /></div><div className="history-copy"><strong>{item.studioName}</strong><span>Im Studio eingecheckt</span></div><div className="history-date">{dateLabel(item.checkedInAt)}<br />{timeLabel(item.checkedInAt)} Uhr</div></div>)}</div></> : <EmptyView icon={<History size={22} />} title="Deine Geschichte beginnt hier." description="Nach deinem ersten Besuch werden deine Check-ins an dieser Stelle angezeigt." />}
    <div className="footer-line">Deine Besuche bleiben deine Geschichte.</div>
  </div>;
}
function PushPreference() {
  const [state, setState] = useState<'loading' | 'ready' | 'unsupported' | 'error'>('loading');
  const [optedIn, setOptedIn] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    let detach = () => {};
    let registrationSequence = 0;
    if (!supportsPushEnvironment()) {
      setState('unsupported');
      return;
    }
    void getOneSignal().then(sdk => {
      if (!active) return;
      if (!sdk.Notifications.isPushSupported()) {
        setState('unsupported');
        return;
      }
      const refresh = () => {
        if (!active) return;
        const subscribed = sdk.User.PushSubscription.optedIn;
        const id = sdk.User.PushSubscription.id;
        setOptedIn(subscribed);
        setDenied(Notification.permission === 'denied');
        if (subscribed) {
          rememberPushChoice(true);
          if (id) {
            const sequence = ++registrationSequence;
            void registerPushSubscription(id).then(() => {
              if (active && sequence === registrationSequence) {
                rememberPushSubscriptionId(id);
                setRegistered(true);
                setError('');
              } else if (!sdk.User.PushSubscription.optedIn || sdk.User.PushSubscription.id !== id) {
                void unregisterMemberPushSubscription(id).catch(() => {});
              }
            }).catch(() => {
              if (active && sequence === registrationSequence) {
                setRegistered(false);
                setError('Dieses Gerät konnte nicht mit deiner Mitgliedschaft verknüpft werden. Bitte versuche es erneut.');
              }
            });
          } else setRegistered(false);
        } else {
          registrationSequence++;
          setRegistered(false);
          // Permission revocation can occur outside the toggle button.
          const previousId = storedPushSubscriptionId();
          if (previousId) {
            void unregisterMemberPushSubscription(previousId).then(() => rememberPushSubscriptionId(null)).catch(() => {
              if (active) setError('Die Push-Abmeldung konnte nicht gespeichert werden. Bitte versuche es erneut.');
            });
          }
        }
      };
      sdk.User.PushSubscription.addEventListener('change', refresh);
      sdk.Notifications.addEventListener('permissionChange', refresh);
      detach = () => {
        sdk.User.PushSubscription.removeEventListener('change', refresh);
        sdk.Notifications.removeEventListener('permissionChange', refresh);
      };
      refresh();
      setState('ready');
    }).catch(() => { if (active) setState('error'); });
    return () => { active = false; detach(); };
  }, []);

  const toggle = async () => {
    setBusy(true);
    setError('');
    try {
      const sdk = await getOneSignal();
      if (optedIn && registered) {
        const id = storedPushSubscriptionId() || sdk.User.PushSubscription.id;
        await sdk.User.PushSubscription.optOut();
        if (id) await unregisterMemberPushSubscription(id);
        rememberPushSubscriptionId(null);
      } else if (!optedIn) {
        await sdk.User.PushSubscription.optIn();
      }
      const subscribed = sdk.User.PushSubscription.optedIn;
      setOptedIn(subscribed);
      setDenied(Notification.permission === 'denied');
      rememberPushChoice(subscribed);
      if (subscribed) {
        const id = sdk.User.PushSubscription.id;
        if (!id) {
          setRegistered(false);
          setError('OneSignal richtet dieses Gerät noch ein. Bitte versuche es gleich erneut.');
        } else {
          await registerPushSubscription(id);
          rememberPushSubscriptionId(id);
          setRegistered(true);
        }
      } else {
        setRegistered(false);
      }
      if (!optedIn && !subscribed) {
        setError(Notification.permission === 'denied'
          ? 'Benachrichtigungen sind im Browser blockiert. Bitte ändere die Berechtigung in deinen Browser-Einstellungen.'
          : 'Dieses Gerät konnte noch nicht für Push angemeldet werden. Bitte versuche es erneut.');
      }
    } catch {
      setRegistered(false);
      setError('Die Push-Einstellung konnte nicht gespeichert werden. Bitte versuche es erneut.');
    } finally {
      setBusy(false);
    }
  };

  return <section className="soft-card email-preference" aria-labelledby="push-preference-title" data-testid="push-preference">
    <div><h2 id="push-preference-title">Push auf diesem Gerät</h2>
      <p>Du entscheidest, ob Fiudia auf diesem Gerät Push-Benachrichtigungen für Kursänderungen senden darf. Dein Studio wählt beim Ändern eines Kurses den Benachrichtigungskanal.</p>
      {state === 'ready' && <p role="status" data-testid="status-push-subscription">{optedIn && registered ? 'Dieses Gerät ist für Push mit deiner Mitgliedschaft angemeldet.' : optedIn ? 'Dieses Gerät ist noch nicht mit deiner Mitgliedschaft verknüpft.' : denied ? 'Benachrichtigungen sind im Browser blockiert.' : 'Dieses Gerät ist nicht für Push angemeldet.'}</p>}
      {state === 'unsupported' && <p role="status">Dieser Browser oder diese Verbindung unterstützt keine Push-Benachrichtigungen.</p>}
      {state === 'error' && <p role="alert">Push konnte hier nicht eingerichtet werden. Prüfe die OneSignal-Konfiguration für diese Website.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <button className="button button-secondary" type="button" disabled={state !== 'ready' || busy || (denied && !optedIn)} onClick={() => { void toggle(); }} data-testid="button-toggle-push">
      {busy ? 'Bitte warten …' : optedIn ? registered ? 'Gerät abmelden' : 'Verknüpfung erneut versuchen' : 'Benachrichtigungen erlauben'}
    </button>
  </section>;
}

function emailDeliveryMessage(status: MemberNotification['emailDeliveryStatus']) {
  switch (status) {
    case 'pending': return 'E-Mail wartet auf Versand';
    case 'sending': return 'E-Mail wird versendet';
    case 'sent': return 'E-Mail an den Anbieter übergeben';
    case 'failed': return 'E-Mail konnte bisher nicht versendet werden';
    case 'skipped': return 'E-Mail wurde nicht versendet';
    default: return null;
  }
}

function NotificationsPage({ home }: { home: MemberHome }) {
  const notifications = useInfiniteQuery(memberNotificationArchiveQueryOptions());
  const markRead = useNotificationRead();
  const emailPreference = useEmailPreference();
  const [preferenceError, setPreferenceError] = useState('');
  const [actionError, setActionError] = useState<{ id: number; message: string } | null>(null);
  const read = async (id: number) => {
    setActionError(null);
    try { await markRead.mutateAsync({ id }); }
    catch { setActionError({ id, message: 'Der Hinweis konnte nicht als gelesen markiert werden. Bitte versuche es erneut.' }); }
  };
  const items = notifications.data?.pages.flat() ?? [];
  return <div className="page"><PageHeader eyebrow="Hinweise" title="Deine Hinweise." description="Hier erfährst du, wenn sich etwas an deinen Kursbuchungen oder Wartelistenplätzen ändert." />
    <PushPreference />
    <section className="soft-card email-preference" aria-labelledby="email-preference-title">
      <div><h2 id="email-preference-title">E-Mail für freie Kursplätze</h2>
        <p>Wenn du von der Warteliste nachrückst, kannst du zusätzlich eine E-Mail an die Adresse deiner Mitgliedschaft erhalten. Ist der E-Mail-Versand vorübergehend nicht verfügbar, bleibt dein Hinweis hier sichtbar.</p>
      </div>
      <label className="email-preference-toggle">
        <input type="checkbox" checked={home.waitlistEmailEnabled} disabled={emailPreference.isPending}
          onChange={async (event) => {
            setPreferenceError('');
            try { await emailPreference.mutateAsync({ data: { waitlistEmailEnabled: event.target.checked } }); }
            catch { setPreferenceError('Deine Einstellung konnte nicht gespeichert werden. Bitte versuche es erneut.'); }
          }}
          data-testid="checkbox-waitlist-email" />
        <span>E-Mail-Hinweise {home.waitlistEmailEnabled ? 'aktiviert' : 'aktivieren'}</span>
      </label>
      {preferenceError && <p className="form-error" role="alert">{preferenceError}</p>}
    </section>
    {notifications.isLoading ? <div className="skeleton-page" data-testid="status-notifications-loading"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div> :
      notifications.isError && !notifications.data ? <ErrorView title="Hinweise nicht erreichbar" onRetry={() => { void notifications.refetch(); }} /> :
      items.length ? <><div className="notification-list" data-testid="list-notifications">{items.map(item => <article className={`notification-item ${item.readAt ? '' : 'unread'}`} key={item.id} data-testid={`card-notification-${item.id}`}>
        <div className="notification-icon"><Bell size={20} /></div><div className="notification-content"><div className="eyebrow">{item.readAt ? 'Gelesen' : 'Neu'}</div><h3>{item.title}</h3><p>{item.body}</p>{item.emailDeliveryStatus && <div className={`notification-email-status email-${item.emailDeliveryStatus}`} role="status" data-testid={`status-notification-email-${item.id}`}>{emailDeliveryMessage(item.emailDeliveryStatus)}</div>}<time dateTime={item.createdAt}>{dateLabel(item.createdAt)} · {timeLabel(item.createdAt)} Uhr</time>
          <div className="notification-actions"><Link href={`/courses/${item.courseId}`} className="text-link" data-testid={`link-notification-courses-${item.id}`}>Kurs ansehen <ArrowRight size={14} /></Link>{item.readAt ? <span className="read-label" data-testid={`status-notification-read-${item.id}`}><Check size={13} /> Gelesen</span> : <button className="button button-quiet" type="button" disabled={markRead.isPending} onClick={() => { void read(item.id); }} data-testid={`button-mark-read-${item.id}`}>{markRead.isPending && markRead.variables?.id === item.id ? 'Wird gespeichert …' : 'Als gelesen markieren'}</button>}</div>
          {actionError?.id === item.id && <div className="form-error" role="alert" data-testid={`status-notification-error-${item.id}`}>{actionError.message}</div>}
        </div></article>)}</div>
        {notifications.hasNextPage && <button type="button" className="button button-secondary" disabled={notifications.isFetchingNextPage} onClick={() => { void notifications.fetchNextPage(); }} data-testid="button-older-notifications">{notifications.isFetchingNextPage ? 'Ältere Hinweise werden geladen …' : 'Ältere Hinweise laden'}</button>}
        {notifications.isFetchNextPageError && <p className="form-error" role="alert">Ältere Hinweise konnten nicht geladen werden. <button type="button" className="text-link" onClick={() => { void notifications.fetchNextPage(); }}>Erneut versuchen</button></p>}
      </> :
      <EmptyView icon={<Bell size={22} />} title="Alles auf dem Laufenden." description="Noch keine Hinweise. Änderungen an deinen Kursbuchungen und Wartelistenplätzen erscheinen hier." action={<Link href="/courses" className="button button-secondary" data-testid="link-notification-empty-courses">Kurse ansehen <ArrowRight size={15} /></Link>} />}
    <div className="footer-line">Deine Hinweise sind nur für dich sichtbar.</div>
  </div>;
}
function invitationError(error: unknown) {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  if (status === 400 || status === 404 || status === 409 || status === 410) return 'Dieser Einladungslink ist ungültig, abgelaufen oder wurde bereits verwendet. Bitte fordere bei deinem Studio eine neue Einladung an.';
  if (status === 403 || status === 422) return 'Die bestätigte E-Mail-Adresse deines Kontos passt nicht zur Einladung oder die Mitgliedschaft ist bereits verbunden. Melde dich mit dem eingeladenen Konto an oder kontaktiere dein Studio.';
  return 'Die Einladung konnte nicht angenommen werden. Prüfe deine bestätigte E-Mail-Adresse und versuche es erneut. Falls der Link abgelaufen ist, fordere eine neue Einladung bei deinem Studio an.';
}
function InvitePage({ token, member }: { token: string; member: Member | null }) {
  const accept = useInvitationAcceptance();
  const [, navigate] = useLocation();
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    try {
      await acceptInvitation(sessionStorage, token, data => accept.mutateAsync({ data }));
      navigate('/', { replace: true });
    } catch (failure) { setError(invitationError(failure)); }
  };
  const leave = () => {
    clearInvite(sessionStorage);
    navigate('/connect', { replace: true });
  };
  return <div className="page"><PageHeader eyebrow="Einladung" title="Dein Platz wartet." description="Du entscheidest, ob du diese persönliche Einladung annehmen möchtest." />
    <div className="soft-card invite-card"><div className="empty-icon"><Ticket size={22} /></div><h2>Mitgliedschaft verbinden</h2><p>{member ? 'Dieses Konto ist bereits mit einer Mitgliedschaft verbunden. Falls du eine andere Einladung erhalten hast, kläre die Zuordnung bitte zuerst mit deinem Studio.' : 'Mit einem Klick verbindest du dein Fiudia Konto mit der Mitgliedschaft, für die dein Studio dich eingeladen hat. Der Link kann nur einmal verwendet werden.'}</p>
      {error && <div className="form-error" role="alert" data-testid="status-invite-error">{error}</div>}
      <div className="invite-actions"><button className="button button-primary" type="button" disabled={accept.isPending || Boolean(member) || !token} onClick={() => { void submit(); }} data-testid="button-accept-invitation">{accept.isPending ? 'Wird verbunden …' : 'Einladung annehmen'} <ArrowRight size={15} /></button><button type="button" className="button button-quiet" onClick={leave} disabled={accept.isPending} data-testid="button-invite-connect">Andere Möglichkeiten</button></div>
    </div><p className="invite-hint"><ShieldCheck size={15} /> Verwende das Konto mit der bestätigten E-Mail-Adresse, an die dein Studio die Einladung geschickt hat. Stimmt sie nicht überein, kannst du die Einladung nicht annehmen.</p>
    <div className="footer-line">Nur du kannst diese Einladung annehmen.</div>
  </div>;
}
function InviteEntry() {
  const { token } = useParams<{ token: string }>();
  const { isLoaded, isSignedIn } = useAuth();
  const savedToken = useRef<string | null>(null);
  // Preserve the one-use secret only in this tab across Clerk's authentication flow.
  const redirect = token && savedToken.current !== token
    ? enterInvitation(sessionStorage, token, isSignedIn)
    : isSignedIn ? null : '/sign-in';
  if (token) savedToken.current = token;
  if (!isLoaded) return <LoadingPage />;
  if (redirect) return <Redirect to={redirect} />;
  return <AuthenticatedPage page="invite" token={token} />;
}
function ConnectPage({ member }: { member: Member | null }) {
  const form = useForm<{ memberId: string }>({ defaultValues: { memberId: '' } });
  const { claim } = useMemberActions();
  const [, navigate] = useLocation();
  const submit = async ({ memberId }: { memberId: string }) => {
    const id = Number(memberId.trim());
    try { await claim.mutateAsync({ data: { memberId: id } }); navigate('/'); }
    catch { /* Mutation error is shown below. */ }
  };
  return <div className="page"><PageHeader eyebrow="Mitgliedschaft" title={member ? 'Dein Studio. Dein Platz.' : 'Hier gehörst du hin.'} description={member ? 'Deine Mitgliedschaft ist mit deinem Fiudia Konto verbunden.' : 'Der persönliche Einladungslink deines Studios ist der normale Weg zu deiner Mitgliedschaft. Melde dich mit der bestätigten E-Mail-Adresse an, an die die Einladung geschickt wurde.'} />
    <div className="connect-layout">
      {member ? <div className="soft-card"><div className="linked-summary"><span className="avatar" style={{ width: 50, height: 50, flexBasis: 50, fontSize: 16 }}>{initials(member.fullName)}</span><div><div className="eyebrow">Verbundene Mitgliedschaft</div><strong data-testid="text-member-name">{member.fullName}</strong><p data-testid="text-member-studio">{member.studioName} · {member.membershipType}</p></div></div><div style={{ marginTop: 24 }}><span className="status-chip"><Check size={12} /> Verbunden</span></div><div style={{ marginTop: 28 }}><Link href="/" className="button button-primary" data-testid="link-back-today">Zurück zu Heute <ArrowRight size={15} /></Link></div></div> :
      <div className="soft-card"><div className="empty-icon"><Link2 size={21} /></div><h2 style={{ fontFamily: 'Space Grotesk', fontSize: 23, letterSpacing: '-.05em', margin: '0 0 8px' }}>Deine Einladung</h2><p style={{ color: '#707784', fontSize: 13, lineHeight: 1.65, margin: '0 0 28px' }}>Öffne den persönlichen Link aus der Nachricht deines Studios. Noch keinen Link erhalten? Bitte dein Studio um eine Einladung. Deine Konto-E-Mail muss bestätigt sein und mit der eingeladenen Adresse übereinstimmen.</p><div className="eyebrow" style={{ marginBottom: 12 }}>Alternativ · Mitgliedsnummer</div><p style={{ color: '#707784', fontSize: 12, lineHeight: 1.65 }}>Falls du keinen Einladungslink nutzen kannst, bleibt die Verbindung über deine Mitgliedsnummer möglich.</p><Form {...form}><form className="connect-form" onSubmit={form.handleSubmit(submit)}><FormField control={form.control} name="memberId" rules={{ required: 'Bitte gib deine Mitgliedsnummer ein.', validate: value => Number.isSafeInteger(Number(value.trim())) && Number(value.trim()) > 0 || 'Bitte gib eine gültige Mitgliedsnummer ein.' }} render={({ field }) => <FormItem><FormLabel>Deine Mitgliedsnummer</FormLabel><FormControl><input {...field} className="field" id="member-id" type="text" inputMode="numeric" placeholder="Mitgliedsnummer eingeben" autoComplete="off" data-testid="input-member-id" /></FormControl><FormMessage /></FormItem>} /><div className="field-help">Du findest die Nummer in deiner Mitgliedsbestätigung. Bei Fragen hilft dir dein Studio weiter.</div>{claim.isError && <div className="form-error" role="alert" data-testid="status-claim-error">{errorMessage(claim.error)}</div>}<button type="submit" className="button button-primary" disabled={claim.isPending} data-testid="button-claim-membership">{claim.isPending ? 'Wird verbunden …' : 'Mit Nummer verbinden'} <ArrowRight size={15} /></button></form></Form></div>}
      <aside className="connect-aside"><ShieldCheck size={26} strokeWidth={1.6} /><h3>Nur für dich.</h3><p>Dein Konto ist durch deine Anmeldung geschützt. Nach dem Verbinden siehst du ausschließlich die für dich verfügbaren Bereiche deines Studios. Deine Mitgliedschaft muss zu deiner bestätigten E-Mail-Adresse passen.</p></aside>
    </div><div className="footer-line">Deine Daten gehören zu dir.</div>
  </div>;
}
function ProfilePage({ member }: { member: Member }) {
  const update = useOwnMemberProfile();
  const billing = useGetMemberBilling();
  const checkout = useCreateMemberBillingCheckout();
  const form = useForm({
    defaultValues: {
      fullName: member.fullName, phone: member.phone || '', birthDate: member.birthDate || '',
      address: member.address || '', billingInterval: member.billingInterval,
    },
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [billingError, setBillingError] = useState('');
  const startSepa = async () => {
    setBillingError('');
    try {
      const result = await checkout.mutateAsync();
      window.location.assign(result.url);
    } catch {
      setBillingError('Der SEPA-Checkout konnte nicht gestartet werden. Bitte versuche es erneut.');
    }
  };
  const submit = form.handleSubmit(async values => {
    setMessage(''); setError('');
    try {
      await update.mutateAsync({ data: {
        fullName: values.fullName.trim(), phone: values.phone || null,
        birthDate: values.birthDate || null, address: values.address.trim() || null,
        billingInterval: values.billingInterval,
      } });
      setMessage('Deine Angaben wurden gespeichert.');
    } catch (failure) { setError(errorMessage(failure)); }
  });
  return <div className="page">
    <PageHeader eyebrow="Mein Profil" title="Deine Angaben." description="Hier kannst du deine persönlichen Daten und Vertragsangaben selbst aktualisieren." />
    <form className="soft-card profile-form" onSubmit={submit}>
      <div className="profile-grid">
        <label className="profile-field">Vollständiger Name<input className="field" {...form.register('fullName', { required: true, minLength: 2, maxLength: 160 })} /></label>
        <label className="profile-field">Telefon<input className="field" type="tel" {...form.register('phone')} /></label>
        <label className="profile-field">Geburtsdatum<input className="field" type="date" {...form.register('birthDate')} /></label>
        <label className="profile-field">E-Mail (Konto)<span className="field profile-readonly">{member.email || 'Keine E-Mail'}</span><Link className="text-link" href="/account">E-Mail im Konto ändern</Link></label>
        <label className="profile-field profile-wide">Adresse<textarea className="field profile-textarea" {...form.register('address')} /></label>
        <label className="profile-field">Tarif<span className="field profile-readonly">{member.membershipType}</span></label>
        <label className="profile-field">Abbuchungsrhythmus<select className="field" disabled={!billing.data?.canStartCheckout} {...form.register('billingInterval')}>
          <option value="monthly">Monatlich – kein Rabatt</option>
          <option value="semiannual">Halbjährlich – 5 % Rabatt</option>
          <option value="annual">Jährlich – 10 % Rabatt</option>
        </select></label>
        <label className="profile-field">Vertragsbeginn<span className="field profile-readonly">{member.contractStart || 'Nicht hinterlegt'}</span></label>
        <label className="profile-field">Vertragsdauer<span className="field profile-readonly">{member.contractDurationMonths ? `${member.contractDurationMonths} Monate` : 'Nicht hinterlegt'}</span></label>
      </div>
      <p className="field-help">Tarif und Vertragsdaten können nur vom Studio geändert werden. Deine Bankdaten und dein SEPA-Mandat gibst du sicher bei Stripe ein; Fiudia speichert keine Bankverbindung.</p>
      {billing.isLoading && <p className="field-help" role="status">SEPA-Status wird geladen …</p>}
      {billing.isError && <p className="form-error" role="alert">Der SEPA-Status konnte nicht geladen werden.</p>}
      {billing.data?.status === 'active' && <p className="profile-success" role="status">SEPA-Lastschrift ist aktiv. Der Tarifwechsel ist bis zur Änderung durch dein Studio gesperrt.</p>}
      {billing.data?.status === 'checkout_pending' && <p className="field-help" role="status">Dein SEPA-Checkout läuft noch. Bitte schließe ihn bei Stripe ab.</p>}
      {billing.data?.status === 'pending' && <p className="field-help" role="status">Dein SEPA-Mandat wird von Stripe verarbeitet.</p>}
      {billing.data?.status === 'past_due' && <p className="form-error" role="alert">Bei deiner letzten Abbuchung gab es ein Problem. Bitte wende dich an dein Studio.</p>}
      {billing.data?.canStartCheckout && <button className="button button-primary" type="button" onClick={() => void startSepa()} disabled={checkout.isPending}>
        {checkout.isPending ? 'Stripe wird geöffnet …' : 'SEPA-Lastschrift einrichten'} <ArrowRight size={15} />
      </button>}
      {billingError && <div className="form-error" role="alert">{billingError}</div>}
      {error && <div className="form-error" role="alert">{error}</div>}
      {message && <div className="profile-success" role="status">{message}</div>}
      <button className="button button-primary" type="submit" disabled={update.isPending}>{update.isPending ? 'Wird gespeichert …' : 'Änderungen speichern'} <Check size={15} /></button>
    </form>
    <div className="footer-line">Deine Vertragsangaben bleiben mit deinem Studio verbunden.</div>
  </div>;
}
function AccountPage() {
  return <div className="page"><PageHeader eyebrow="Konto" title="Konto verwalten." description="Ändere hier deine Anmelde-E-Mail und bestätige sie, bevor du dein Mitgliederprofil speicherst." /><div className="account-profile"><UserProfile /></div></div>;
}
function AuthPage({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const signIn = mode === 'sign-in';
  const redirect = afterAuthPath(sessionStorage, basePath, signIn ? '/' : '/connect');
  useEffect(() => pageTitle(signIn ? 'Anmelden' : 'Registrieren'), [signIn]);
  return <div className="auth-page"><div className="auth-aside auth-aside--photo"><img className={signIn ? 'auth-photo' : 'auth-photo auth-photo--signup'} src={signIn ? memberLoginPhoto : memberSignupPhoto} alt="" aria-hidden="true" /><Brand /><h1>Dein Studio.<br /><em>Dein Rhythmus.</em></h1><p>Alle Kurse, deine Buchungen und jeder Besuch. Ein ruhiger Ort für alles, was dich in Bewegung hält.</p><small>Fiudia / Dein Raum für Bewegung</small></div><main className="auth-main"><div className="auth-content"><div className="eyebrow">Fiudia Mitglieder</div><h2>{signIn ? 'Willkommen zurück.' : 'Schön, dass du da bist.'}</h2><p>{pendingInvite() ? 'Deine Einladung wartet nach der Anmeldung auf dich. Nutze die E-Mail-Adresse, an die dein Studio sie geschickt hat, und bestätige sie.' : signIn ? 'Melde dich an und mach dort weiter, wo du aufgehört hast.' : 'Erstelle ein Konto und verbinde danach deine Mitgliedschaft.'}</p><div className="auth-clerk">{signIn ? <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} forceRedirectUrl={redirect} /> : <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} forceRedirectUrl={redirect} />}</div><div className="auth-switch">{signIn ? <>Noch kein Konto? <Link href="/sign-up" data-testid="link-sign-up">Registrieren</Link></> : <>Schon dabei? <Link href="/sign-in" data-testid="link-sign-in">Anmelden</Link></>}</div></div></main></div>;
}
function ProtectedPage({ page, courseDetail = false }: { page: 'today' | 'courses' | 'check-ins' | 'connect' | 'notifications' | 'profile' | 'account'; courseDetail?: boolean }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <LoadingPage />;
  if (!isSignedIn) return <Redirect to="/sign-in" />;
  const pending = pendingInvitationPath(sessionStorage);
  if (pending) return <Redirect to={pending} />;
  return <AuthenticatedPage page={page} courseDetail={courseDetail} />;
}
function AuthenticatedPage({ page, token = '', courseDetail = false }: { page: 'today' | 'courses' | 'check-ins' | 'connect' | 'notifications' | 'profile' | 'account' | 'invite'; token?: string; courseDetail?: boolean }) {
  const home = useGetMemberHome();
  if (home.isLoading) return <MemberShell member={null}><LoadingPage /></MemberShell>;
  if (home.isError || !home.data) return <MemberShell member={null}><div className="page"><PageHeader eyebrow="Dein Fiudia" title="Einen Moment." description="Wir versuchen, deine Mitgliedschaft zu laden." /><ErrorView onRetry={() => { void home.refetch(); }} /></div></MemberShell>;
  const memberHome = home.data;
  const member = memberHome.member;
  if ((page === 'courses' || page === 'notifications') && (!member || !memberHome.coursesEnabled) || page === 'check-ins' && !memberHome.checkInsEnabled) return <Redirect to="/" />;
  if (courseDetail) return <MemberShell member={member} home={memberHome}><CourseDetailPage /></MemberShell>;
  return <MemberShell member={member} home={memberHome}>{page === 'invite' ? <InvitePage token={token} member={member} /> : page !== 'connect' && !member ? <MembershipRequired /> : page === 'today' ? <TodayPage member={member!} home={memberHome} /> : page === 'courses' ? <CoursesPage /> : page === 'notifications' ? <NotificationsPage home={memberHome} /> : page === 'check-ins' ? <CheckInsPage /> : page === 'profile' ? <ProfilePage member={member!} /> : page === 'account' ? <AccountPage /> : <ConnectPage member={member} />}</MemberShell>;
}
function NotFoundPage() {
  useEffect(() => pageTitle('Seite nicht gefunden'), []);
  return <div className="page"><Brand /><div style={{ marginTop: 70 }}><EmptyView icon={<Clock3 size={22} />} title="Hier ist gerade nichts." description="Diese Seite gibt es nicht. Dein nächster Moment wartet auf der Startseite." action={<Link href="/" className="button button-primary" data-testid="link-not-found-home">Zur Startseite <ArrowRight size={15} /></Link>} /></div></div>;
}
function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}
function Routes() {
  return <RoutedErrorBoundary><Switch>
    <Route path="/sign-in/*?"><AuthPage mode="sign-in" /></Route>
    <Route path="/sign-up/*?"><AuthPage mode="sign-up" /></Route>
    <Route path="/"><ProtectedPage page="today" /></Route>
    <Route path="/invite/:token"><InviteEntry /></Route>
    <Route path="/courses/:id"><ProtectedPage page="courses" courseDetail /></Route>
    <Route path="/courses"><ProtectedPage page="courses" /></Route>
    <Route path="/notifications"><ProtectedPage page="notifications" /></Route>
    <Route path="/check-ins"><ProtectedPage page="check-ins" /></Route>
    <Route path="/connect"><ProtectedPage page="connect" /></Route>
    <Route path="/profile"><ProtectedPage page="profile" /></Route>
    <Route path="/account"><ProtectedPage page="account" /></Route>
    <Route component={NotFoundPage} />
  </Switch></RoutedErrorBoundary>;
}
function IdentityQueryBoundary() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const previousUserId = useRef<string | null>(null);
  const previousPushIdentity = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!isLoaded) return;
    if (previousPushIdentity.current && (!isSignedIn || previousPushIdentity.current !== userId)) {
      clearCoursePushClickState();
    }
    previousPushIdentity.current = userId ?? null;
  }, [isLoaded, isSignedIn, userId]);
  useEffect(() => {
    if (!storedPushSubscriptionId()) return;
    // The click handler is installed before OneSignal init; init has no prompt
    // enabled and this path never creates or registers a subscription.
    void getOneSignal().catch(() => {});
  }, []);
  useEffect(() => {
    if (!isLoaded) return;
    if (previousUserId.current && (!isSignedIn || previousUserId.current !== userId)) {
      clearCoursePushClickState();
    }
    if (!isSignedIn || (previousUserId.current && previousUserId.current !== userId)) {
      void optOutOnSignOut().catch(() => {});
    }
    previousUserId.current = userId ?? null;
  }, [isLoaded, isSignedIn, userId]);
  // A query cache belongs to one exact Clerk identity, never to the application.
  // Construct the new cache during render, before any member screen can read it.
  const client = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: true, retry: 1 } } }),
    [userId],
  );
  if (!isLoaded || (isSignedIn && !userId)) return <LoadingPage />;
  return <QueryClientProvider key={userId ?? 'signed-out'} client={client}>
    <TooltipProvider><Routes /><Toaster /></TooltipProvider>
  </QueryClientProvider>;
}
function ClerkApp() {
  const [, navigate] = useLocation();
  const appearance = {
    theme: shadcn,
    cssLayerName: 'clerk',
    options: {
      logoPlacement: 'inside' as const,
      logoLinkUrl: `${basePath}/`,
      logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
    },
    variables: { colorPrimary: '#66548f', colorForeground: '#29354c', colorMutedForeground: '#707784', colorBackground: '#fdfbf7', colorInput: '#f7f5ef', colorInputForeground: '#29354c', colorNeutral: '#d9d3c6', fontFamily: 'DM Sans', borderRadius: '0.9rem' },
    elements: { rootBox: 'w-full', cardBox: 'w-full !shadow-none !border !border-[#e5e0d4] !rounded-[18px] overflow-hidden', card: '!shadow-none !border-0 !bg-transparent', footer: '!shadow-none !border-0 !bg-transparent', socialButtonsBlockButton: '!bg-[#f7f5ef] !border-[#d9d3c6]', socialButtonsBlockButtonText: '!text-[#29354c]', formButtonPrimary: '!bg-[#29354c] !text-white hover:!bg-[#43506b]', formFieldInput: '!bg-[#f7f5ef] !border-[#d9d3c6]' },
  };
  return <ClerkProvider publishableKey={clerkKey} proxyUrl={clerkProxy} appearance={appearance} localization={clerkLocalization} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} routerPush={(to: string) => navigate(stripBase(to))} routerReplace={(to: string) => navigate(stripBase(to), { replace: true })}>
    <IdentityQueryBoundary />
  </ClerkProvider>;
}
function App() {
  return <WouterRouter base={basePath}><ClerkApp /></WouterRouter>;
}
export default App;