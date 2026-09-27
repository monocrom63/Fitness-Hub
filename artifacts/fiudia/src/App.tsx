import { useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, SignIn, SignUp, useAuth, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/shared/keys';
import { shadcn } from '@clerk/themes';
import { deDE } from '@clerk/localizations';
import {
  Activity, ArrowRight, CalendarDays, Check, ChevronDown, CircleHelp, Clock3, Copy, Dumbbell,
  LayoutDashboard, LogOut, Mail, Menu, MoreHorizontal, Pencil, Plus, Search, Settings2, DoorOpen,
  ShieldCheck, Sparkles, Users, UserRound, X, Zap,
} from 'lucide-react';
import {
  getGetDashboardQueryKey, getGetMeQueryKey, getListCourseBookingsQueryKey, getListCoursesQueryKey, getListInvitationsQueryKey,
  getListMembersQueryKey, getListModulesQueryKey, useAcceptInvitation, useCompleteOnboarding, useCreateCheckIn,
  useCancelStaffCourseBooking, useCreateCourse, useCreateInvitation, useCreateMember, useCreateMemberInvitation, useCreateStaffCourseBooking, useGetDashboard, useGetMe,
  getListStudiosQueryKey, useListCourseBookings, useListCourses, useListInvitations, useListMembers, useListModules, useListStudios, useUpdateMember, useUpdateModule,
} from '@workspace/api-client-react';
import type { Course, CourseRosterBooking, Dashboard, Invitation, Member, MemberInvitationLink, Me, ModuleKey, ModuleSetting, Role } from '@workspace/api-client-react';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation, useRoute } from 'wouter';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ErrorBoundary } from '@/components/error-boundary';
import { ActionStrip, PulsePage, TodayPage } from './TodayPulse';
import RoomClosuresPage from './RoomClosuresPage';
import TrainerAbsencesPage from './TrainerAbsencesPage';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

function stripBase(path: string) {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#6554c0',
    colorForeground: '#1e2638',
    colorMutedForeground: '#687086',
    colorDanger: '#d7584d',
    colorBackground: '#ffffff',
    colorInput: '#f5f7fb',
    colorInputForeground: '#1e2638',
    colorNeutral: '#dfe4ed',
    fontFamily: 'DM Sans',
    borderRadius: '0.8rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-white rounded-2xl w-[440px] max-w-full overflow-hidden shadow-xl',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#1e2638] font-semibold',
    headerSubtitle: 'text-[#687086]',
    socialButtonsBlockButtonText: '!text-[#1e2638]',
    formFieldLabel: 'text-[#1e2638]',
    footerActionLink: 'text-[#6554c0]',
    footerActionText: 'text-[#687086]',
    dividerText: 'text-[#687086]',
    identityPreviewEditButton: 'text-[#6554c0]',
    formFieldSuccessText: 'text-[#287d68]',
    alertText: 'text-[#a53d36]',
    logoBox: 'h-10',
    logoImage: 'h-10',
    socialButtonsBlockButton: '!border-[#dfe4ed] !bg-[#f5f7fb]',
    formButtonPrimary: 'bg-[#1e2638] hover:bg-[#303c55] text-white',
    formFieldInput: 'bg-[#f5f7fb] border-[#dfe4ed] text-[#1e2638]',
    footerAction: 'bg-transparent',
    dividerLine: 'bg-[#dfe4ed]',
    alert: 'bg-[#fff3f1] border-[#f3c6c0]',
    otpCodeFieldInput: 'bg-[#f5f7fb] border-[#dfe4ed]',
    formFieldRow: 'mb-4',
    main: 'p-8',
  },
};

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
      title: 'Fiudia-Workspace erstellen',
      titleCombined: 'Fiudia-Workspace erstellen',
      subtitle: 'Registriere dich bei Fiudia und starte deinen Workspace.',
      subtitleCombined: 'Registriere dich bei Fiudia und starte deinen Workspace.',
    },
  },
};

function timeAgo(value: string) {
  const minutes = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  return `vor ${Math.floor(hours / 24)} Tagen`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function initials(name = 'Fiudia') {
  return name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function roleLabel(role?: Role | null) {
  if (role === 'district_manager') return 'Bezirksleitung';
  if (role === 'studio_manager') return 'Studioleitung';
  return 'Studio-Team';
}

function Brand({ light = false }: { light?: boolean }) {
  return <Link href="/" className={`brand-mark ${light ? 'brand-mark-light' : ''}`} data-testid="link-brand">
    <span className="brand-symbol">F</span><span>Fiudia</span>
  </Link>;
}

function LoadingBlock({ label = 'Arbeitsbereich wird geladen' }: { label?: string }) {
  return <div className="loading-state" data-testid="status-loading"><span className="loading-orb" /><span>{label}</span></div>;
}

function ErrorBlock({ retry }: { retry: () => void }) {
  return <div className="empty-state error-state" data-testid="status-error"><div className="empty-icon"><CircleHelp size={22} /></div><h3>Das hat nicht geklappt</h3><p>Die Daten konnten gerade nicht geladen werden.</p><button className="button button-dark" onClick={retry} data-testid="button-retry">Erneut versuchen</button></div>;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: React.ReactNode }) {
  return <header className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</header>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true"><div className="modal-head"><div><div className="eyebrow">Fiudia workspace</div><h2>{title}</h2></div><button className="icon-button" onClick={onClose} data-testid="button-close-modal"><X size={18} /></button></div>{children}</div></div>;
}

function TextField({ label, name, value, onChange, type = 'text', placeholder }: { label: string; name: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  return <label className="field"><span>{label}</span><input data-testid={`input-${name}`} type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} required /></label>;
}

function AppShell({ children, me, modules }: { children: React.ReactNode; me: Me; modules: ModuleSetting[] }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const { signOut } = useClerk();
  const logOut = () => signOut({ redirectUrl: `${basePath}/sign-in` });
  useEffect(() => {
    if (!profileOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!profileRef.current?.contains(event.target as Node)) setProfileOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProfileOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [profileOpen]);
  const nav = [
    { href: '/dashboard', label: 'Today', icon: LayoutDashboard },
    ...(moduleEnabled(modules, 'pulse') ? [{ href: '/pulse', label: 'Pulse', icon: Activity }] : []),
    ...(moduleEnabled(modules, 'members') ? [{ href: '/members', label: 'Mitglieder', icon: Users }] : []),
    ...(moduleEnabled(modules, 'courses') ? [{ href: '/courses', label: 'Kurse', icon: CalendarDays }] : []),
    ...((me.role === 'studio_manager' || me.role === 'district_manager') && moduleEnabled(modules, 'courses') ? [{ href: '/rooms', label: 'Räume', icon: DoorOpen }] : []),
    ...((me.role === 'studio_manager' || me.role === 'district_manager') && moduleEnabled(modules, 'courses') ? [{ href: '/team/absences', label: 'Trainer-Ausfälle', icon: UserRound }] : []),
    ...(me.role !== 'studio_employee' && moduleEnabled(modules, 'team') ? [{ href: '/team', label: 'Team', icon: UserRound }] : []),
  ];
  return <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
      <div className="sidebar-top"><Brand light /><button className="icon-button sidebar-close" onClick={() => setMobileOpen(false)} data-testid="button-close-navigation"><X size={18} /></button></div>
      <div className="workspace-switcher"><div className="workspace-dot">{initials(me.studioName || me.organizationName || 'F')}</div><div><strong>{me.studioName || 'Dein Workspace'}</strong><span>{me.organizationName || 'Neue Organisation'}</span></div><ChevronDown size={16} /></div>
      <nav className="main-nav">{nav.map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={() => setMobileOpen(false)} className={`nav-link ${location === href ? 'nav-link-active' : ''}`} data-testid={`link-nav-${label.toLowerCase()}`}><Icon size={18} /><span>{label}</span>{href === '/members' && <span className="nav-count">live</span>}</Link>)}</nav>
      <div className="sidebar-note"><Sparkles size={16} /><span>Ein guter Tag beginnt mit Übersicht.</span></div>
      <div className="sidebar-bottom"><Link href="/settings" className="nav-link" data-testid="link-nav-settings"><Settings2 size={18} /><span>Einstellungen</span></Link><button className="profile-row" onClick={logOut} data-testid="button-sign-out"><span className="avatar avatar-small">{initials(me.userName)}</span><span className="profile-copy"><strong>{me.userName || 'Fiudia Nutzer'}</strong><small>{roleLabel(me.role)}</small></span><LogOut size={16} /></button></div>
    </aside>
      <div className="main-wrap"><header className="topbar"><button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} data-testid="button-open-navigation"><Menu size={20} /></button><div className="top-search"><Search size={17} /><span>Dein Fiudia Arbeitsbereich</span></div><div className="top-actions"><span className="status-chip"><span className="status-dot" />Alles aktuell</span><div className="profile-menu" ref={profileRef}><button type="button" className="profile-trigger" aria-label="Profilmenü öffnen" aria-expanded={profileOpen} aria-controls="profile-menu" onClick={() => setProfileOpen(open => !open)} data-testid="button-profile-menu"><span className="avatar">{initials(me.userName)}</span><ChevronDown size={14} /></button>{profileOpen && <div className="profile-dropdown" id="profile-menu"><div className="profile-dropdown-user"><strong>{me.userName || 'Fiudia Nutzer'}</strong><small>{roleLabel(me.role)}</small></div><button type="button" onClick={logOut} data-testid="button-top-sign-out"><LogOut size={16} /> Abmelden</button></div>}</div></div></header><main className="main-content">{children}</main></div><ActionStrip me={me} modules={modules} />
  </div>;
}

function moduleEnabled(modules: ModuleSetting[], key: ModuleKey) {
  return modules.some(module => module.key === key && module.enabled);
}

function AuthenticatedData({ children }: { children: (me: Me, modules: ModuleSetting[], retryModules: () => void, modulesError: boolean) => React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const meQuery = useGetMe({ query: { queryKey: getGetMeQueryKey(), enabled: isLoaded && !!isSignedIn } });
  const modulesQuery = useListModules({ query: { queryKey: getListModulesQueryKey(), enabled: isLoaded && !!isSignedIn && !!meQuery.data?.isOnboarded, refetchInterval: 60000 } });
  if (!isLoaded) return <LoadingBlock label="Anmeldung wird geprüft" />;
  if (!isSignedIn) return <Redirect to="/sign-in" />;
  if (meQuery.isLoading) return <LoadingBlock label="Dein Fiudia workspace wird vorbereitet" />;
  if (meQuery.isError) return <ErrorBlock retry={() => meQuery.refetch()} />;
  if (!meQuery.data?.isOnboarded) return <Redirect to="/onboarding" />;
  if (modulesQuery.isLoading) return <LoadingBlock label="Module werden geladen" />;
  const modules = modulesQuery.isError ? [] : modulesQuery.data || [];
  return <AppShell me={meQuery.data} modules={modules}>{children(meQuery.data, modules, () => { void modulesQuery.refetch(); }, modulesQuery.isError)}</AppShell>;
}

function HomeRedirect() {
  const { isSignedIn, isLoaded } = useAuth();
  if (!isLoaded) return <LoadingBlock />;
  if (isSignedIn) return <Redirect to="/dashboard" />;
  return <LandingPage />;
}

function LandingPage() {
  return <div className="landing-page"><header className="landing-nav"><Brand /><div className="landing-links"><a href="#perspective">Perspektiven</a><a href="#rhythm">Arbeitsalltag</a><Link href="/sign-in" className="button button-quiet" data-testid="link-sign-in">Anmelden <ArrowRight size={16} /></Link></div></header><section className="landing-hero"><div className="hero-copy"><div className="kicker"><span className="kicker-line" />Fitness operations, die mitdenken</div><h1>Dein Studio.<br /><em>Dein Rhythmus.</em></h1><p>Fiudia verbindet Menschen, Kurse und tägliche Abläufe in einer klaren Oberfläche — automatisch passend zu deiner Rolle.</p><div className="hero-actions"><Link href="/sign-up" className="button button-dark" data-testid="link-sign-up">Workspace starten <ArrowRight size={17} /></Link><a href="#perspective" className="text-link" data-testid="link-learn-more">Mehr über Fiudia <span>↓</span></a></div></div><div className="hero-art"><div className="art-glow" /><div className="hero-orbit orbit-one" /><div className="hero-orbit orbit-two" /><div className="hero-card card-back"><span>studio mood</span><strong>LEBENDIG</strong><small>Menschen. Bewegung. Gemeinschaft.</small></div><div className="hero-card card-front"><div className="mini-top"><span>Fiudia / Heute</span><span className="status-dot" /></div><div className="mini-greeting">Guten Morgen, Lisa.</div><div className="mini-chart"><span style={{ height: '34%' }} /><span style={{ height: '58%' }} /><span style={{ height: '46%' }} /><span style={{ height: '76%' }} /><span style={{ height: '65%' }} /><span style={{ height: '92%' }} /><span style={{ height: '78%' }} /></div><div className="mini-footer"><span>Check-ins heute</span><strong>86</strong><span className="positive-text">+12%</span></div></div></div></section><section id="perspective" className="landing-section perspective-section"><div className="section-label">01 / Eine Plattform. Viele Perspektiven.</div><div className="perspective-grid"><div><h2>Die richtige Ansicht<br /><em>für den Moment.</em></h2><p>Keine überladenen Dashboards. Fiudia sortiert die wichtigen Dinge nach Verantwortung, Ort und Tageszeit.</p></div><div className="role-stack"><div className="role-card role-district"><span className="role-index">01</span><div><strong>Bezirksleitung</strong><p>Alle Standorte im Blick. Trends erkennen, bevor sie zu Aufgaben werden.</p></div><ArrowRight size={18} /></div><div className="role-card role-manager"><span className="role-index">02</span><div><strong>Studioleitung</strong><p>Das eigene Studio steuern — von Mitgliedern bis zur Auslastung.</p></div><ArrowRight size={18} /></div><div className="role-card role-team"><span className="role-index">03</span><div><strong>Studio-Team</strong><p>Der Tag, der vor dir liegt. Klar, schnell, menschlich.</p></div><ArrowRight size={18} /></div></div></div></section><section id="rhythm" className="landing-section rhythm-section"><div className="rhythm-panel"><div><div className="section-label">02 / Der Studio-Rhythmus</div><h2>Weniger suchen.<br />Mehr <em>bewegen.</em></h2><p>Von der ersten Begrüßung bis zum letzten Kurs: Fiudia bringt deinen Alltag in einen natürlichen Flow.</p></div><div className="rhythm-stats"><div><strong>86</strong><span>Check-ins heute</span></div><div><strong>24</strong><span>Kurse diese Woche</span></div><div><strong>1.204</strong><span>aktive Mitglieder</span></div></div></div></section><footer className="landing-footer"><Brand light /><span>Organisationen sind verschieden. Wir auch.</span><span>© 2025 Fiudia</span></footer></div>;
}

function SignInPage() {
  return <div className="auth-page auth-page--photo"><div className="auth-aside auth-aside--photo"><Brand light /><div className="auth-photo-copy"><div className="eyebrow">Fiudia workspace</div><h1>Mehr Raum für<br /><em>gute Arbeit.</em></h1><p>Dein Studio-Alltag, in der Perspektive, die zu dir gehört.</p></div><span className="auth-aside-foot">Für Teams, die Menschen bewegen.</span></div><div className="auth-main"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div></div>;
}

function SignUpPage() {
  return <div className="auth-page"><div className="auth-aside"><Brand light /><div><div className="eyebrow">Starte mit Fiudia</div><h1>Ein besserer Tag<br /><em>beginnt hier.</em></h1><p>Richte deinen Workspace ein und bringe deine Organisation in Bewegung.</p></div><span className="auth-aside-foot">Wächst mit dir. Bleibt bei dir.</span></div><div className="auth-main"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div></div>;
}

function OnboardingPage() {
  const [, setLocation] = useLocation();
  const mutation = useCompleteOnboarding();
  const [form, setForm] = useState({ organizationName: '', studioName: '', city: '' });
  const update = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));
  return <div className="onboarding-page"><div className="onboarding-card"><Brand /><div className="step-count">01 <span /> 01</div><div className="eyebrow">Dein Anfang bei Fiudia</div><h1>Erzähl uns von<br /><em>deinem Studio.</em></h1><p className="lead">Wir richten deinen Workspace passend zu deiner Organisation ein. Das dauert weniger als zwei Minuten.</p><form onSubmit={(e) => { e.preventDefault(); mutation.mutate({ data: form }, { onSuccess: () => setLocation('/dashboard') }); }}><TextField label="Name der Organisation" name="organization-name" value={form.organizationName} onChange={update('organizationName')} placeholder="z. B. Nordlicht Fitness" /><TextField label="Name des ersten Studios" name="studio-name" value={form.studioName} onChange={update('studioName')} placeholder="z. B. Berlin Mitte" /><TextField label="Stadt" name="city" value={form.city} onChange={update('city')} placeholder="z. B. Berlin" /><button className="button button-dark button-wide" disabled={mutation.isPending} data-testid="button-complete-onboarding">{mutation.isPending ? 'Workspace wird erstellt …' : 'Workspace einrichten'} <ArrowRight size={17} /></button>{mutation.isError && <p className="form-error" data-testid="status-onboarding-error">Bitte prüfe deine Angaben und versuche es erneut.</p>}</form></div><div className="onboarding-art"><div className="onboarding-orb" /><span>Menschen.<br />Bewegung.<br /><em>Gemeinschaft.</em></span></div></div>;
}

function DashboardPage({ me, modules }: { me: Me; modules: ModuleSetting[] }) {
  return <TodayPage me={me} modules={modules} />;
  /*
  const query = useGetDashboard({ query: { queryKey: getGetDashboardQueryKey() } });
  if (query.isLoading) return <LoadingBlock label="Deine Übersicht wird geladen" />;
  if (query.isError || !query.data) return <ErrorBlock retry={() => query.refetch()} />;
  const dashboard = query.data as Dashboard;
  const role = roleLabel(dashboard.role);
  return <><PageHeader eyebrow={`${role} / ${dashboard.studioName || me.studioName || 'Workspace'}`} title={`Guten Morgen, ${dashboard.userName || me.userName}.`} description={dashboard.role === 'district_manager' ? 'Hier ist dein Netzwerk auf einen Blick.' : 'Schön, dass du da bist. Hier ist dein Studio-Tag.'} action={<button className="button button-dark" data-testid="button-quick-action"><Plus size={17} /> Schnellaktion</button>} /><div className="dashboard-hero"><div><span className="hero-status"><span className="status-dot" /> Heute, {new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</span><h2>{dashboard.role === 'district_manager' ? 'Dein Netzwerk wächst.' : 'Kleine Schritte. Große Wirkung.'}</h2><p>{dashboard.role === 'district_manager' ? 'Vergleiche Standorte, finde Muster und gib deinen Teams Rückenwind.' : 'Du machst den Unterschied im Studio — Tag für Tag.'}</p></div><div className="hero-abstract"><div className="abstract-ring ring-a" /><div className="abstract-ring ring-b" /><span>{dashboard.role === 'district_manager' ? '5' : '1'}<small> Standorte</small></span></div></div><section className="metric-grid">{dashboard.metrics.map((metric, index) => <div className={`metric-card metric-${metric.tone}`} key={`${metric.label}-${index}`} data-testid={`metric-card-${index}`}><div className="metric-label">{metric.label}</div><strong>{metric.value}</strong><span className="metric-delta">{metric.delta}</span><div className="metric-spark"><i /><i /><i /><i /><i /></div></div>)}</section><div className="dashboard-grid"><div className="panel timeline-panel"><div className="panel-head"><div><div className="eyebrow">Dein Tag</div><h3>Heute im Studio</h3></div><Link href="/courses" className="panel-link" data-testid="link-dashboard-courses">Alle Kurse <ArrowRight size={14} /></Link></div>{dashboard.courses.length ? <div className="course-timeline">{dashboard.courses.slice(0, 5).map((course) => <div className="timeline-row" key={course.id} data-testid={`course-row-${course.id}`}><span className="timeline-time">{formatTime(course.startsAt)}</span><span className="timeline-line" /><span className="timeline-info"><strong>{course.title}</strong><small>{course.instructor} · {course.room}</small></span><span className={`pill pill-${course.status}`}>{course.enrolled}/{course.capacity}</span></div>)}</div> : <div className="empty-inline"><CalendarDays size={18} /> Keine Kurse für heute.</div>}</div><div className="panel activity-panel"><div className="panel-head"><div><div className="eyebrow">Aus dem Workspace</div><h3>Letzte Aktivität</h3></div><Activity size={18} className="muted-icon" /></div>{dashboard.activities.length ? <div className="activity-list">{dashboard.activities.slice(0, 5).map((item) => <div className="activity-row" key={item.id} data-testid={`activity-row-${item.id}`}><span className={`activity-icon activity-${item.category}`}><Activity size={15} /></span><div><strong>{item.title}</strong><p>{item.description}</p><small>{timeAgo(item.happenedAt)}</small></div></div>)}</div> : <div className="empty-inline">Noch keine Aktivitäten.</div>}</div></div></>;
  */
}

function MembersContent({ me }: { me: Me }) {
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [selected, setSelected] = useState<Member | null>(null);
  const memberParams = me.role !== 'studio_employee' && search ? { search } : undefined;
  const membersQuery = useListMembers(memberParams, { query: { queryKey: getListMembersQueryKey(memberParams) } });
  const checkIn = useCreateCheckIn();
  const create = useCreateMember();
  const updateMember = useUpdateMember();
  const [form, setForm] = useState({ fullName: '', email: '', phone: '', membershipType: 'Standard', status: 'active' });
  const updateForm = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));
  const openCreate = () => { setSelected(null); setForm({ fullName: '', email: '', phone: '', membershipType: 'Standard', status: 'active' }); setModal('create'); };
  const openEdit = (member: Member) => { setSelected(member); setForm({ fullName: member.fullName, email: member.email || '', phone: member.phone || '', membershipType: member.membershipType, status: member.status }); setModal('edit'); };
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (me.role === 'studio_employee') return; if (modal === 'create') create.mutate({ data: { ...form, studioId: me.studioId || 0, status: form.status as 'active' | 'trial' | 'paused' } }, { onSuccess: () => { client.invalidateQueries({ queryKey: getListMembersQueryKey() }); client.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); setModal(null); } }); else if (selected) updateMember.mutate({ id: selected.id, data: { ...form, phone: form.phone || null, status: form.status as 'active' | 'trial' | 'paused' } }, { onSuccess: () => { client.invalidateQueries({ queryKey: getListMembersQueryKey() }); client.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); setModal(null); } }); };
  const members = me.role === 'studio_employee' && search ? (membersQuery.data || []).filter(member => member.fullName.toLocaleLowerCase('de-DE').includes(search.toLocaleLowerCase('de-DE'))) : membersQuery.data || [];
  const manager = me.role !== 'studio_employee';
  return <><PageHeader eyebrow={`${me.studioName || 'Workspace'} / Menschen`} title="Mitglieder" description="Behalte Beziehungen im Blick — nicht nur Datensätze." action={manager && <button className="button button-dark" onClick={openCreate} data-testid="button-create-member"><Plus size={17} /> Mitglied anlegen</button>} /><div className="toolbar"><div className="input-search"><Search size={17} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={manager ? 'Nach Name, E-Mail oder Mitgliedsnummer suchen …' : 'Nach Namen suchen …'} data-testid="input-member-search" /></div><span className="toolbar-count">{members.length} Mitglieder</span></div>{membersQuery.isLoading ? <LoadingBlock label="Mitglieder werden geladen" /> : membersQuery.isError ? <ErrorBlock retry={() => membersQuery.refetch()} /> : members.length === 0 ? <div className="empty-state" data-testid="status-members-empty"><div className="empty-icon"><Users size={22} /></div><h3>Noch keine Mitglieder</h3><p>Hier erscheinen die Mitglieder deines Studios.</p>{manager && <button className="button button-dark" onClick={openCreate} data-testid="button-empty-create-member"><Plus size={16} /> Erstes Mitglied anlegen</button>}</div> : <div className={`table-card ${manager ? '' : 'employee-members'}`}><div className="member-table-head"><span>Mitglied</span>{manager && <span>Kontakt</span>}<span>Mitgliedschaft</span><span>Status</span><span>Letzter Check-in</span><span /></div>{members.map((member) => <div className="member-row" key={member.id} data-testid={`member-row-${member.id}`}><div className="member-name"><span className="avatar avatar-violet">{initials(member.fullName)}</span><span><strong>{member.fullName}</strong><small>{manager && <span data-testid={`text-member-id-${member.id}`}>Mitglieds-ID: {member.id} · </span>}seit {new Intl.DateTimeFormat('de-DE', { month: 'short', year: 'numeric' }).format(new Date(member.joinedAt))}</small></span></div>{manager && <div className="member-contact"><strong>{member.email || 'Keine E-Mail'}</strong><small>{member.phone || 'Keine Telefonnummer'}</small></div>}<span className="membership-type">{member.membershipType}</span><span className={`status-label status-${member.status}`}><i />{member.status === 'active' ? 'Aktiv' : member.status === 'trial' ? 'Probetraining' : 'Pausiert'}</span><span className="last-checkin">{member.lastCheckIn ? timeAgo(member.lastCheckIn) : 'Noch nicht'}</span><div className="row-actions"><button className="icon-button" disabled={checkIn.isPending} onClick={() => checkIn.mutate({ data: { memberId: member.id, studioId: member.studioId } }, { onSuccess: () => { client.invalidateQueries({ queryKey: getListMembersQueryKey() }); client.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); } })} title="Check-in" data-testid={`button-checkin-member-${member.id}`}><Check size={16} /></button>{manager && <button className="icon-button" onClick={() => openEdit(member)} title="Bearbeiten" data-testid={`button-edit-member-${member.id}`}><Pencil size={16} /></button>}</div></div>)}</div>}{checkIn.isError && <p className="form-error" role="alert">Check-in fehlgeschlagen. Bitte erneut versuchen.</p>}{manager && modal && <Modal title={modal === 'create' ? 'Neues Mitglied' : 'Mitglied bearbeiten'} onClose={() => setModal(null)}><form onSubmit={submit} className="modal-form">{modal === 'edit' && selected && <p data-testid={`text-edit-member-id-${selected.id}`}>Mitglieds-ID für die Konto-Verknüpfung: <strong>{selected.id}</strong></p>}<TextField label="Vollständiger Name" name="member-name" value={form.fullName} onChange={updateForm('fullName')} /><TextField label="E-Mail-Adresse" name="member-email" value={form.email} onChange={updateForm('email')} type="email" /><TextField label="Telefon" name="member-phone" value={form.phone} onChange={updateForm('phone')} /><TextField label="Mitgliedschaft" name="member-membership" value={form.membershipType} onChange={updateForm('membershipType')} /><label className="field"><span>Status</span><select value={form.status} onChange={(e) => updateForm('status')(e.target.value)} data-testid="select-member-status"><option value="active">Aktiv</option><option value="trial">Probetraining</option><option value="paused">Pausiert</option></select></label>{(create.isError || updateMember.isError) && <p className="form-error" role="alert">Mitglied konnte nicht gespeichert werden.</p>}<button className="button button-dark button-wide" disabled={create.isPending || updateMember.isPending} data-testid="button-save-member"><Check size={16} /> Speichern</button></form></Modal>}</>;
}

function MemberInvitationDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  const invitation = useCreateMemberInvitation();
  const [link, setLink] = useState<MemberInvitationLink | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const shareableUrl = link ? new URL(link.inviteUrl, window.location.origin).href : null;
  return <Modal title="Mitglied einladen" onClose={onClose}>
    <div className="invitation-details">
      <p>Ein einmaliger, vertraulicher Einladungslink für <strong>{member.fullName}</strong>. Teile ihn nur mit der zugeordneten Person.</p>
      <div className="invitation-recipient"><Mail size={16} /><span data-testid="text-invitation-recipient">{link?.memberEmail || member.email}</span></div>
      {!link ? <>
        <p className="booking-hint">Der Link wird nur direkt nach dem Erstellen angezeigt. Sichere ihn jetzt, denn er kann später nicht erneut eingesehen werden.</p>
        {invitation.isError && <p className="form-error" role="alert" data-testid="status-invitation-error">Einladung konnte nicht erstellt werden. Bitte versuche es erneut.</p>}
        <button className="button button-dark button-wide" disabled={invitation.isPending} onClick={() => invitation.mutate({ id: member.id }, { onSuccess: result => setLink(result) })} data-testid={`button-generate-member-invitation-${member.id}`}>{invitation.isPending ? 'Link wird erstellt …' : 'Einmaligen Link erstellen'}</button>
      </> : <>
        <div className="invitation-link"><span data-testid="text-member-invitation-link">{shareableUrl}</span></div>
        <p className="booking-hint" data-testid="text-member-invitation-expiry">Gültig bis {new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(link.expiresAt))}. Nur für {link.memberEmail}.</p>
        <button className="button button-dark button-wide" onClick={async () => { try { if (!shareableUrl) return; await navigator.clipboard.writeText(shareableUrl); setCopyState('copied'); } catch { setCopyState('error'); } }} data-testid="button-copy-member-invitation"><Copy size={16} /> Link kopieren</button>
        {copyState === 'copied' && <p className="booking-result" role="status" data-testid="status-invitation-copied">Link kopiert.</p>}
        {copyState === 'error' && <p className="form-error" role="alert" data-testid="status-invitation-copy-error">Kopieren nicht möglich. Bitte den Link manuell kopieren.</p>}
      </>}
    </div>
  </Modal>;
}

function MembersPage({ me }: { me: Me }) {
  const manager = me.role === 'studio_manager' || me.role === 'district_manager';
  const [inviteMember, setInviteMember] = useState<Member | null>(null);
  return <>
    <MembersContent me={me} />
    {manager && <MemberInvitationList onSelect={setInviteMember} />}
    {manager && inviteMember && <MemberInvitationDialog key={inviteMember.id} member={inviteMember} onClose={() => setInviteMember(null)} />}
  </>;
}

function MemberInvitationList({ onSelect }: { onSelect: (member: Member) => void }) {
  const query = useListMembers(undefined, { query: { queryKey: getListMembersQueryKey() } });
  return <section className="panel invitation-management" aria-label="Mitgliedereinladungen">
    <div className="panel-head"><div><div className="eyebrow">Sicherer Zugang</div><h3>Mitglieder einladen</h3></div><Mail size={19} className="muted-icon" /></div>
    <p className="booking-hint">Erstelle einen einmaligen Link für ein Mitglied mit hinterlegter E-Mail-Adresse.</p>
    {query.isLoading ? <div className="pulse-skeleton" role="status"><i /></div> : query.isError ? <ErrorBlock retry={() => query.refetch()} /> : query.data?.length ? <div className="invitation-members">{query.data.map(member => <div className="invitation-member" key={member.id} data-testid={`row-invitation-member-${member.id}`}><span><strong>{member.fullName}</strong><small>{member.email || 'Keine E-Mail hinterlegt'}</small></span><button className="button button-outline" disabled={!member.email} onClick={() => onSelect(member)} data-testid={`button-invite-member-${member.id}`}>Link erstellen</button></div>)}</div> : <p className="booking-hint">Noch keine Mitglieder vorhanden.</p>}
  </section>;
}

function CourseRoster({ course, onClose }: { course: Course; onClose: () => void }) {
  const client = useQueryClient();
  const query = useListCourseBookings(course.id, { query: { queryKey: getListCourseBookingsQueryKey(course.id) } });
  const cancel = useCancelStaffCourseBooking();
  const [confirmBooking, setConfirmBooking] = useState<CourseRosterBooking | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const confirmed = (query.data || []).filter(item => item.status === 'confirmed');
  const waitlisted = (query.data || []).filter(item => item.status === 'waitlisted').sort((a, b) => (a.waitlistPosition ?? Infinity) - (b.waitlistPosition ?? Infinity));
  const cancelBooking = () => {
    if (!confirmBooking) return;
    cancel.mutate({ id: course.id, memberId: confirmBooking.memberId, data: { expectedStatus: confirmBooking.status } }, { onSuccess: () => {
      setConfirmBooking(null);
      setConflict(false);
      setMessage('Buchung storniert. Die Kursliste und Warteliste werden aktualisiert.');
      void client.invalidateQueries({ queryKey: getListCourseBookingsQueryKey(course.id) });
      void client.invalidateQueries({ queryKey: getListCoursesQueryKey() });
      void client.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    }, onError: error => {
      if (error.status === 409) {
        setConfirmBooking(null);
        setConflict(true);
        setMessage(null);
        void client.invalidateQueries({ queryKey: getListCourseBookingsQueryKey(course.id) });
        void client.invalidateQueries({ queryKey: getListCoursesQueryKey() });
        void client.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
      }
    } });
  };
  return <Modal title={`${course.title} · Teilnehmerliste`} onClose={onClose}>
    <div className="roster-content">
      {query.isLoading ? <div className="pulse-skeleton" role="status"><i /><i /></div> : query.isError ? <ErrorBlock retry={() => query.refetch()} /> : <>
        {[{ title: 'Bestätigt', items: confirmed }, { title: 'Warteliste', items: waitlisted }].map(group => <section className="roster-group" key={group.title}>
          <h3>{group.title} <span>{group.items.length}</span></h3>
          {group.items.length ? group.items.map(item => <div className="roster-member" key={item.id} data-testid={`row-course-booking-${item.id}`}>
            <span className="avatar avatar-violet">{initials(item.memberName)}</span>
            <span className="roster-member-name"><strong>{item.memberName}</strong><small>{item.status === 'waitlisted' ? `Warteliste · Platz ${item.waitlistPosition ?? '–'}` : 'Platz bestätigt'}</small></span>
            <button className="button button-outline roster-cancel" onClick={() => { setConfirmBooking(item); setMessage(null); setConflict(false); cancel.reset(); }} data-testid={`button-cancel-course-booking-${item.id}`}>Stornieren</button>
          </div>) : <p className="booking-hint">Noch keine {group.title === 'Bestätigt' ? 'bestätigten Buchungen' : 'Mitglieder auf der Warteliste'}.</p>}
        </section>)}
      </>}
      {message && <p className="booking-result" role="status" data-testid="status-cancel-booking-success">{message}</p>}
      {conflict && <p className="form-error" role="alert" data-testid="status-cancel-booking-conflict">Der Buchungsstatus hat sich geändert. Es wurde nichts storniert. Bitte prüfe die aktualisierte Teilnehmerliste und bestätige eine Stornierung bei Bedarf erneut.</p>}
      {confirmBooking && <div className="roster-confirm" role="group" aria-label="Buchung stornieren">
        <strong>Buchung von {confirmBooking.memberName} wirklich stornieren?</strong>
        <p>Bei einem bestätigten Platz kann ein Mitglied von der Warteliste nachrücken.</p>
        {cancel.isError && <p className="form-error" role="alert" data-testid="status-cancel-booking-error">Stornierung fehlgeschlagen. Bitte erneut versuchen.</p>}
        <div className="roster-confirm-actions"><button className="button button-outline" disabled={cancel.isPending} onClick={() => setConfirmBooking(null)} data-testid="button-keep-course-booking">Zurück</button><button className="button button-dark" disabled={cancel.isPending} onClick={cancelBooking} data-testid="button-confirm-cancel-course-booking">{cancel.isPending ? 'Storniere …' : 'Buchung stornieren'}</button></div>
      </div>}
    </div>
  </Modal>;
}

function CoursesPage({ me, modules }: { me: Me; modules: ModuleSetting[] }) {
  const client = useQueryClient();
  const manager = me.role === 'studio_manager' || me.role === 'district_manager';
  const canBookMembers = manager && moduleEnabled(modules, 'members');
  const query = useListCourses({ query: { queryKey: getListCoursesQueryKey() } });
  const create = useCreateCourse();
  const booking = useCreateStaffCourseBooking();
  const [bookingCourse, setBookingCourse] = useState<Course | null>(null);
  const [bookingMemberId, setBookingMemberId] = useState('');
  const [bookingResult, setBookingResult] = useState<string | null>(null);
  const [rosterCourse, setRosterCourse] = useState<Course | null>(null);
  const membersQuery = useListMembers(undefined, { query: { queryKey: getListMembersQueryKey(), enabled: !!bookingCourse && canBookMembers } });
  useEffect(() => { if (!canBookMembers) setBookingCourse(null); }, [canBookMembers]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', instructor: '', startsAt: '', endsAt: '', capacity: '20', room: '' });
  const update = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));
  const submit = (e: React.FormEvent) => { e.preventDefault(); create.mutate({ data: { ...form, capacity: Number(form.capacity), studioId: me.studioId || 0, startsAt: new Date(form.startsAt).toISOString(), endsAt: new Date(form.endsAt).toISOString() } }, { onSuccess: () => { client.invalidateQueries({ queryKey: getListCoursesQueryKey() }); client.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); setOpen(false); } }); };
  const book = (e: React.FormEvent) => { e.preventDefault(); if (!bookingCourse || !bookingMemberId || !canBookMembers) return; setBookingResult(null); booking.mutate({ id: bookingCourse.id, data: { memberId: Number(bookingMemberId) } }, { onSuccess: result => { setBookingResult(result.status === 'confirmed' ? 'Platz bestätigt.' : result.status === 'waitlisted' ? `Auf der Warteliste${result.waitlistPosition ? ` · Position ${result.waitlistPosition}` : ''}.` : 'Buchungsstatus: ' + result.status); void client.invalidateQueries({ queryKey: getListCourseBookingsQueryKey(bookingCourse.id) }); void client.invalidateQueries({ queryKey: getListCoursesQueryKey() }); void client.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); } }); };
  const courses = query.data || [];
  return <>
    <PageHeader eyebrow={`${me.studioName || 'Workspace'} / Rhythmus`} title="Kurse" description="Kursplan und Buchungen im Blick." action={me.role !== 'studio_employee' && <button className="button button-dark" onClick={() => setOpen(true)} data-testid="button-create-course"><Plus size={17} /> Kurs planen</button>} />
    {query.isLoading ? <LoadingBlock label="Kursplan wird geladen" /> : query.isError ? <ErrorBlock retry={() => query.refetch()} /> : courses.length === 0 ? <div className="empty-state"><div className="empty-icon"><CalendarDays size={22} /></div><h3>Dein Kursplan ist noch leer</h3><p>Neue Kurse erscheinen hier.</p>{me.role !== 'studio_employee' && <button className="button button-dark" onClick={() => setOpen(true)} data-testid="button-empty-create-course"><Plus size={16} /> Ersten Kurs planen</button>}</div> : <div className="course-grid">{courses.map((course: Course) => <div className="course-card" key={course.id} data-testid={`course-card-${course.id}`}>
      <div className="course-accent" /><div className="course-card-top"><span className={`pill pill-${course.status}`}>{course.status === 'scheduled' ? 'Geplant' : course.status === 'full' ? 'Ausgebucht' : 'Abgesagt'}</span></div>
      <div className="course-time">{formatTime(course.startsAt)} <span>—</span> {formatTime(course.endsAt)}</div><h3>{course.title}</h3><p>{course.instructor} · {course.room}</p>
      <div className="course-card-bottom"><span><Users size={15} /> {course.enrolled} / {course.capacity}</span><span className={course.enrolled / course.capacity > .8 ? 'warning-text' : 'positive-text'}>{Math.round((course.enrolled / course.capacity) * 100)}% belegt</span></div>
      <div className="capacity-bar"><i style={{ width: `${Math.min(100, (course.enrolled / course.capacity) * 100)}%` }} /></div>
      {manager && <button className="button button-outline course-book-button" onClick={() => setRosterCourse(course)} data-testid={`button-course-roster-${course.id}`}><Users size={15} /> Teilnehmerliste ansehen</button>}
      {canBookMembers && course.status !== 'cancelled' && new Date(course.startsAt).getTime() > Date.now() && <button className="button button-outline course-book-button" onClick={() => { setBookingCourse(course); setBookingMemberId(''); setBookingResult(null); booking.reset(); }} data-testid={`button-book-course-${course.id}`}>Mitglied buchen <ArrowRight size={15} /></button>}
    </div>)}</div>}
    {manager && rosterCourse && <CourseRoster key={rosterCourse.id} course={rosterCourse} onClose={() => setRosterCourse(null)} />}
    {canBookMembers && bookingCourse && <Modal title={`${bookingCourse.title} · Mitglied buchen`} onClose={() => setBookingCourse(null)}><form className="modal-form" onSubmit={book}><p className="booking-hint">Wähle ein aktives Mitglied. Bei ausgebuchten Kursen entscheidet die Buchung automatisch über die Warteliste.</p>{membersQuery.isLoading ? <div className="pulse-skeleton" role="status"><i /></div> : membersQuery.isError ? <ErrorBlock retry={() => membersQuery.refetch()} /> : <label className="field"><span>Aktives Mitglied</span><select required value={bookingMemberId} onChange={e => { setBookingMemberId(e.target.value); setBookingResult(null); }} data-testid="select-booking-member"><option value="">Mitglied auswählen</option>{(membersQuery.data || []).filter(member => member.status === 'active' && member.studioId === bookingCourse.studioId).map(member => <option key={member.id} value={member.id}>{member.fullName}</option>)}</select></label>}{!membersQuery.isLoading && !membersQuery.isError && !(membersQuery.data || []).some(member => member.status === 'active' && member.studioId === bookingCourse.studioId) && <p className="booking-hint">Keine aktiven Mitglieder für dieses Studio verfügbar.</p>}{bookingResult && <p className="booking-result" role="status" data-testid="status-booking-result">{bookingResult}</p>}{booking.isError && <p className="form-error" role="alert" data-testid="status-booking-error">Buchung fehlgeschlagen. Bitte prüfe die Berechtigung und versuche es erneut.</p>}<button className="button button-dark button-wide" disabled={!bookingMemberId || booking.isPending || membersQuery.isError || membersQuery.isLoading} data-testid="button-confirm-booking">{booking.isPending ? 'Buchung läuft …' : 'Buchung bestätigen'}</button></form></Modal>}
    {me.role !== 'studio_employee' && open && <Modal title="Neuen Kurs planen" onClose={() => setOpen(false)}><form onSubmit={submit} className="modal-form"><TextField label="Kursname" name="course-title" value={form.title} onChange={update('title')} placeholder="z. B. Yoga Flow" /><TextField label="Trainer:in" name="course-instructor" value={form.instructor} onChange={update('instructor')} /><div className="field-grid"><TextField label="Beginn" name="course-start" value={form.startsAt} onChange={update('startsAt')} type="datetime-local" /><TextField label="Ende" name="course-end" value={form.endsAt} onChange={update('endsAt')} type="datetime-local" /></div><div className="field-grid"><TextField label="Kapazität" name="course-capacity" value={form.capacity} onChange={update('capacity')} type="number" /><TextField label="Raum" name="course-room" value={form.room} onChange={update('room')} /></div>{create.isError && <p className="form-error" role="alert">Kurs konnte nicht gespeichert werden.</p>}<button className="button button-dark button-wide" disabled={create.isPending} data-testid="button-save-course"><Check size={16} /> Kurs speichern</button></form></Modal>}
  </>;
}

function TeamPage({ me }: { me: Me }) {
  const client = useQueryClient();
  const query = useListInvitations({ query: { queryKey: getListInvitationsQueryKey() } });
  const studios = useListStudios({ query: { queryKey: getListStudiosQueryKey(), enabled: me.role === 'district_manager' } });
  const create = useCreateInvitation();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ email: '', role: 'studio_employee', studioId: String(me.studioId || '') });
  const invitations = query.data || [];
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const studioId = me.role === 'district_manager' ? Number(form.studioId) : me.studioId;
    if (!studioId || (me.role === 'district_manager' && !studios.data?.some(studio => studio.id === studioId))) return;
    create.mutate({ data: { email: form.email, role: form.role as Role, studioId } }, { onSuccess: () => { client.invalidateQueries({ queryKey: getListInvitationsQueryKey() }); setOpen(false); setForm(current => ({ ...current, email: '' })); } });
  };
  return <><PageHeader eyebrow={`${me.organizationName || 'Organisation'} / Zusammenarbeit`} title="Team" description="Die richtigen Menschen, mit der richtigen Verantwortung." action={<button className="button button-dark" onClick={() => setOpen(true)} data-testid="button-create-invitation"><Mail size={17} /> Einladung senden</button>} /><div className="team-intro"><div className="team-intro-icon"><ShieldCheck size={23} /></div><div><strong>Rollen geben Orientierung.</strong><p>Fiudia lädt jede Person automatisch in die passende Perspektive ein. Du vergibst nur Verantwortung — keine Zugriffsrechte per Hand.</p></div></div>{query.isLoading ? <LoadingBlock label="Team wird geladen" /> : query.isError ? <ErrorBlock retry={() => query.refetch()} /> : <div className="table-card invitation-table"><div className="member-table-head"><span>E-Mail</span><span>Rolle</span><span>Studio</span><span>Status</span><span>Gültig bis</span><span /></div>{invitations.length ? invitations.map((invite: Invitation) => <div className="member-row" key={invite.id} data-testid={`invitation-row-${invite.id}`}><div className="member-name"><span className="avatar avatar-mint"><Mail size={16} /></span><span><strong>{invite.email}</strong><small>Einladung #{invite.id}</small></span></div><span className="membership-type">{roleLabel(invite.role)}</span><span className="member-contact">{invite.studioName}</span><span className={`status-label status-${invite.status === 'pending' ? 'trial' : invite.status === 'accepted' ? 'active' : 'paused'}`}><i />{invite.status === 'pending' ? 'Ausstehend' : invite.status === 'accepted' ? 'Angenommen' : 'Abgelaufen'}</span><span className="last-checkin">{new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(invite.expiresAt))}</span><button className="icon-button" onClick={() => navigator.clipboard?.writeText(invite.inviteUrl)} data-testid={`button-copy-invitation-${invite.id}`}><ArrowRight size={16} /></button></div>) : <div className="empty-inline"><Users size={18} /> Noch keine Einladungen.</div>}</div>}{open && <Modal title="Teammitglied einladen" onClose={() => setOpen(false)}><form onSubmit={submit} className="modal-form"><TextField label="E-Mail-Adresse" name="invitation-email" value={form.email} onChange={(value) => setForm((f) => ({ ...f, email: value }))} type="email" placeholder="name@studio.de" /><label className="field"><span>Rolle</span><select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} data-testid="select-invitation-role"><option value="studio_employee">Studio-Team</option><option value="studio_manager">Studioleitung</option>{me.role === 'district_manager' && <option value="district_manager">Bezirksleitung</option>}</select></label>{me.role === 'district_manager' ? <label className="field"><span>Zielstudio</span><select required value={form.studioId} onChange={(e) => setForm(f => ({ ...f, studioId: e.target.value }))} data-testid="select-invitation-studio"><option value="">Studio auswählen</option>{(studios.data || []).map(studio => <option key={studio.id} value={studio.id}>{studio.name}</option>)}</select></label> : <p className="booking-hint">Zielstudio: <strong>{me.studioName}</strong></p>}{studios.isError && me.role === 'district_manager' && <p className="form-error" role="alert">Studios konnten nicht geladen werden. Bitte erneut versuchen.</p>}{create.isError && <p className="form-error" role="alert">Einladung konnte nicht erstellt werden. Bitte prüfe Studio und E-Mail-Adresse.</p>}<button className="button button-dark button-wide" disabled={create.isPending || (me.role === 'district_manager' && (!studios.data || studios.isError))} data-testid="button-send-invitation"><Mail size={16} /> Einladung senden</button></form></Modal>}</>;
}

function InvitePage() {
  const [, setLocation] = useLocation();
  const [, params] = useRoute('/invite/:token');
  const mutation = useAcceptInvitation();
  const { isSignedIn } = useAuth();
  const accept = () => { if (!isSignedIn) { setLocation(`/sign-in?redirect_url=${window.location.pathname}`); return; } if (params?.token) mutation.mutate({ token: params.token }, { onSuccess: () => setLocation('/dashboard') }); };
  return <div className="invite-page"><Brand /><div className="invite-card"><div className="invite-symbol"><Users size={24} /></div><div className="eyebrow">Deine Einladung</div><h1>Gemeinsam wird<br /><em>mehr daraus.</em></h1><p>Du wurdest eingeladen, einem Fiudia-Workspace beizutreten. Nimm deinen Platz im Studio ein.</p><button className="button button-dark button-wide" onClick={accept} disabled={mutation.isPending} data-testid="button-accept-invitation">{mutation.isPending ? 'Einladung wird angenommen …' : isSignedIn ? 'Einladung annehmen' : 'Anmelden und beitreten'} <ArrowRight size={17} /></button>{mutation.isError && <p className="form-error">Diese Einladung ist nicht mehr gültig. Bitte frage die Studioleitung nach einem neuen Link.</p>}</div></div>;
}

function SettingsPage({ me, modules, retryModules, modulesError }: { me: Me; modules: ModuleSetting[]; retryModules: () => void; modulesError: boolean }) {
  const { user } = useUser();
  const { openUserProfile } = useClerk();
  const client = useQueryClient();
  const update = useUpdateModule();
  return <><PageHeader eyebrow="Workspace / Einstellungen" title="Einstellungen" description="Dein Profil und die Module deiner Organisation." /><div className="settings-card"><div className="settings-avatar avatar">{initials(user?.fullName || user?.firstName || 'F')}</div><div><h3>{user?.fullName || user?.firstName || 'Fiudia Nutzer'}</h3><p>{user?.primaryEmailAddress?.emailAddress || 'Dein Konto'}</p></div><button className="button button-outline" onClick={() => openUserProfile()} data-testid="button-open-profile">Profil verwalten</button></div><section className="module-settings"><div className="eyebrow">Organisation / Zugang</div><h2>Module</h2><p>{me.role === 'district_manager' ? 'Bestimme, welche Bereiche deiner Organisation zur Verfügung stehen.' : 'Für deinen Workspace verfügbare Bereiche.'}</p>{modulesError ? <ErrorBlock retry={retryModules} /> : <div className="module-list">{modules.filter(module => me.role === 'district_manager' || module.enabled).map(module => <div className="module-row" key={module.key} data-testid={`module-${module.key}`}><div><strong>{module.title}</strong><span>{module.enabled ? 'Aktiv' : 'Deaktiviert'}</span></div>{me.role === 'district_manager' && <button type="button" role="switch" aria-checked={module.enabled} aria-label={`${module.title} ${module.enabled ? 'deaktivieren' : 'aktivieren'}`} className={`module-switch ${module.enabled ? 'on' : ''}`} disabled={update.isPending} onClick={() => update.mutate({ key: module.key, data: { enabled: !module.enabled } }, { onSuccess: () => { client.invalidateQueries({ queryKey: getListModulesQueryKey() }); client.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); } })} data-testid={`switch-module-${module.key}`}><i /></button>}</div>)}{!modules.some(module => module.enabled) && me.role !== 'district_manager' && <p>Keine weiteren Bereiche sind derzeit aktiviert.</p>}</div>}{update.isError && <p className="form-error" role="alert">Modul konnte nicht aktualisiert werden. Bitte erneut versuchen.</p>}</section></>;
}

function ProtectedRoute({ page }: { page: 'dashboard' | 'pulse' | 'members' | 'courses' | 'rooms' | 'trainer-absences' | 'team' | 'settings' }) {
  return <AuthenticatedData>{(me, modules, retryModules, modulesError) => {
    if (page === 'settings') return <SettingsPage me={me} modules={modules} retryModules={retryModules} modulesError={modulesError} />;
    if (page === 'dashboard') return <DashboardPage me={me} modules={modules} />;
    if (page === 'rooms') return (me.role === 'studio_manager' || me.role === 'district_manager') && moduleEnabled(modules, 'courses') ? <RoomClosuresPage me={me} /> : <div className="empty-state"><div className="empty-icon"><ShieldCheck size={22} /></div><h3>Bereich nicht verfügbar</h3><p>Räume sind nur für Studio- und District-Manager mit aktivem Kursmodul verfügbar.</p><Link href="/dashboard" className="button button-dark">Zur Übersicht</Link></div>;
    if (page === 'trainer-absences') return (me.role === 'studio_manager' || me.role === 'district_manager') && moduleEnabled(modules, 'courses') ? <TrainerAbsencesPage me={me} /> : <div className="empty-state"><div className="empty-icon"><ShieldCheck size={22} /></div><h3>Bereich nicht verfügbar</h3><p>Trainer-Ausfälle sind nur für Manager mit aktivem Kursmodul verfügbar.</p><Link href="/dashboard" className="button button-dark">Zur Übersicht</Link></div>;
    if (!moduleEnabled(modules, page) || (page === 'team' && me.role === 'studio_employee')) return <div className="empty-state"><div className="empty-icon"><ShieldCheck size={22} /></div><h3>Bereich nicht verfügbar</h3><p>Dieses Modul ist für deinen Workspace nicht aktiviert.</p>{modulesError && <button className="button button-outline" onClick={retryModules}>Module erneut laden</button>}<Link href="/dashboard" className="button button-dark">Zur Übersicht</Link></div>;
    return page === 'pulse' ? <PulsePage me={me} /> : page === 'members' ? <MembersPage me={me} /> : page === 'courses' ? <CoursesPage me={me} modules={modules} /> : <TeamPage me={me} />;
  }}</AuthenticatedData>;
}

function NotFoundPage() {
  return <div className="not-found"><Brand /><div className="empty-icon"><CircleHelp size={24} /></div><h1>Diese Seite ist nicht im Plan.</h1><p>Vielleicht hat sie gerade einen freien Tag.</p><Link href="/" className="button button-dark" data-testid="link-not-found-home">Zur Startseite</Link></div>;
}

function Router() {
  return <Switch><Route path="/" component={HomeRedirect} /><Route path="/sign-in/*?" component={SignInPage} /><Route path="/sign-up/*?" component={SignUpPage} /><Route path="/onboarding" component={OnboardingPage} /><Route path="/invite/:token" component={InvitePage} /><Route path="/dashboard"><ProtectedRoute page="dashboard" /></Route><Route path="/pulse"><ProtectedRoute page="pulse" /></Route><Route path="/members"><ProtectedRoute page="members" /></Route><Route path="/courses"><ProtectedRoute page="courses" /></Route><Route path="/rooms"><ProtectedRoute page="rooms" /></Route><Route path="/team/absences"><ProtectedRoute page="trainer-absences" /></Route><Route path="/team"><ProtectedRoute page="team" /></Route><Route path="/settings"><ProtectedRoute page="settings" /></Route><Route component={NotFoundPage} /></Switch>;
}

function IdentityQueryProvider() {
  const [client] = useState(() => new QueryClient());
  return <QueryClientProvider client={client}><Router /><Toaster /></QueryClientProvider>;
}

function ClerkQueryScope() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  if (!isLoaded || (isSignedIn && !userId)) return <LoadingBlock label="Anmeldung wird geprüft" />;
  // A different Clerk identity must never inherit the previous identity's query cache.
  return <IdentityQueryProvider key={userId ?? 'signed-out'} />;
}

function ClerkApp() {
  const [, setLocation] = useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={clerkLocalization} routerPush={(to: string) => setLocation(stripBase(to))} routerReplace={(to: string) => setLocation(stripBase(to), { replace: true })}><ClerkQueryScope /></ClerkProvider>;
}

function App() {
  return <ErrorBoundary><WouterRouter base={basePath}><ClerkApp /></WouterRouter></ErrorBoundary>;
}

export default App;