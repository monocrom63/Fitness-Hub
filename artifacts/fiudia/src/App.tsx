import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, SignIn, SignUp, useAuth, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/shared/keys';
import { shadcn } from '@clerk/themes';
import {
  Activity, ArrowRight, CalendarDays, Check, ChevronDown, CircleHelp, Clock3, Dumbbell,
  LayoutDashboard, LogOut, Mail, Menu, MoreHorizontal, Pencil, Plus, Search, Settings2,
  ShieldCheck, Sparkles, Users, UserRound, X, Zap,
} from 'lucide-react';
import {
  getGetDashboardQueryKey, getGetMeQueryKey, getListCoursesQueryKey, getListInvitationsQueryKey,
  getListMembersQueryKey, useAcceptInvitation, useCompleteOnboarding, useCreateCheckIn,
  useCreateCourse, useCreateInvitation, useCreateMember, useGetDashboard, useGetMe,
  useListCourses, useListInvitations, useListMembers, useUpdateMember,
} from '@workspace/api-client-react';
import type { Course, Dashboard, Invitation, Member, Me, Role } from '@workspace/api-client-react';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation, useRoute } from 'wouter';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ErrorBoundary } from '@/components/error-boundary';

const queryClient = new QueryClient();
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
    socialButtonsBlockButtonText: 'text-[#1e2638]',
    formFieldLabel: 'text-[#1e2638]',
    footerActionLink: 'text-[#6554c0]',
    footerActionText: 'text-[#687086]',
    dividerText: 'text-[#687086]',
    identityPreviewEditButton: 'text-[#6554c0]',
    formFieldSuccessText: 'text-[#287d68]',
    alertText: 'text-[#a53d36]',
    logoBox: 'h-10',
    logoImage: 'h-10',
    socialButtonsBlockButton: 'border-[#dfe4ed] bg-[#f5f7fb]',
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

function AppShell({ children, me }: { children: React.ReactNode; me: Me }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { signOut } = useClerk();
  const nav = [
    { href: '/dashboard', label: 'Übersicht', icon: LayoutDashboard },
    { href: '/members', label: 'Mitglieder', icon: Users },
    { href: '/courses', label: 'Kurse', icon: CalendarDays },
    ...(me.role !== 'studio_employee' ? [{ href: '/team', label: 'Team', icon: UserRound }] : []),
  ];
  return <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
      <div className="sidebar-top"><Brand light /><button className="icon-button sidebar-close" onClick={() => setMobileOpen(false)} data-testid="button-close-navigation"><X size={18} /></button></div>
      <div className="workspace-switcher"><div className="workspace-dot">{initials(me.studioName || me.organizationName || 'F')}</div><div><strong>{me.studioName || 'Dein Workspace'}</strong><span>{me.organizationName || 'Neue Organisation'}</span></div><ChevronDown size={16} /></div>
      <nav className="main-nav">{nav.map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={() => setMobileOpen(false)} className={`nav-link ${location === href ? 'nav-link-active' : ''}`} data-testid={`link-nav-${label.toLowerCase()}`}><Icon size={18} /><span>{label}</span>{href === '/members' && <span className="nav-count">live</span>}</Link>)}</nav>
      <div className="sidebar-note"><Sparkles size={16} /><span>Ein guter Tag beginnt mit Übersicht.</span></div>
      <div className="sidebar-bottom"><Link href="/settings" className="nav-link" data-testid="link-nav-settings"><Settings2 size={18} /><span>Einstellungen</span></Link><button className="profile-row" onClick={() => signOut({ redirectUrl: basePath || '/' })} data-testid="button-sign-out"><span className="avatar avatar-small">{initials(me.userName)}</span><span className="profile-copy"><strong>{me.userName || 'Fiudia Nutzer'}</strong><small>{roleLabel(me.role)}</small></span><LogOut size={16} /></button></div>
    </aside>
    <div className="main-wrap"><header className="topbar"><button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} data-testid="button-open-navigation"><Menu size={20} /></button><div className="top-search"><Search size={17} /><span>Suche nach Mitgliedern, Kursen, Check-ins …</span><kbd>⌘ K</kbd></div><div className="top-actions"><span className="status-chip"><span className="status-dot" />Alles aktuell</span><button className="icon-button" data-testid="button-help"><CircleHelp size={18} /></button><span className="avatar">{initials(me.userName)}</span></div></header><main className="main-content">{children}</main></div>
  </div>;
}

function AuthenticatedData({ children }: { children: (me: Me) => React.ReactNode }) {
  const meQuery = useGetMe({ query: { queryKey: getGetMeQueryKey() } });
  if (meQuery.isLoading) return <LoadingBlock label="Dein Fiudia workspace wird vorbereitet" />;
  if (meQuery.isError) return <ErrorBlock retry={() => meQuery.refetch()} />;
  if (!meQuery.data?.isOnboarded) return <Redirect to="/onboarding" />;
  return <AppShell me={meQuery.data}>{children(meQuery.data)}</AppShell>;
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
  return <div className="auth-page"><div className="auth-aside"><Brand light /><div><div className="eyebrow">Fiudia workspace</div><h1>Mehr Raum für<br /><em>gute Arbeit.</em></h1><p>Dein Studio-Alltag, in der Perspektive, die zu dir gehört.</p></div><span className="auth-aside-foot">Für Teams, die Menschen bewegen.</span></div><div className="auth-main"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div></div>;
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

function DashboardPage({ me }: { me: Me }) {
  const query = useGetDashboard({ query: { queryKey: getGetDashboardQueryKey() } });
  if (query.isLoading) return <LoadingBlock label="Deine Übersicht wird geladen" />;
  if (query.isError || !query.data) return <ErrorBlock retry={() => query.refetch()} />;
  const dashboard = query.data as Dashboard;
  const role = roleLabel(dashboard.role);
  return <><PageHeader eyebrow={`${role} / ${dashboard.studioName || me.studioName || 'Workspace'}`} title={`Guten Morgen, ${dashboard.userName || me.userName}.`} description={dashboard.role === 'district_manager' ? 'Hier ist dein Netzwerk auf einen Blick.' : 'Schön, dass du da bist. Hier ist dein Studio-Tag.'} action={<button className="button button-dark" data-testid="button-quick-action"><Plus size={17} /> Schnellaktion</button>} /><div className="dashboard-hero"><div><span className="hero-status"><span className="status-dot" /> Heute, {new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</span><h2>{dashboard.role === 'district_manager' ? 'Dein Netzwerk wächst.' : 'Kleine Schritte. Große Wirkung.'}</h2><p>{dashboard.role === 'district_manager' ? 'Vergleiche Standorte, finde Muster und gib deinen Teams Rückenwind.' : 'Du machst den Unterschied im Studio — Tag für Tag.'}</p></div><div className="hero-abstract"><div className="abstract-ring ring-a" /><div className="abstract-ring ring-b" /><span>{dashboard.role === 'district_manager' ? '5' : '1'}<small> Standorte</small></span></div></div><section className="metric-grid">{dashboard.metrics.map((metric, index) => <div className={`metric-card metric-${metric.tone}`} key={`${metric.label}-${index}`} data-testid={`metric-card-${index}`}><div className="metric-label">{metric.label}</div><strong>{metric.value}</strong><span className="metric-delta">{metric.delta}</span><div className="metric-spark"><i /><i /><i /><i /><i /></div></div>)}</section><div className="dashboard-grid"><div className="panel timeline-panel"><div className="panel-head"><div><div className="eyebrow">Dein Tag</div><h3>Heute im Studio</h3></div><Link href="/courses" className="panel-link" data-testid="link-dashboard-courses">Alle Kurse <ArrowRight size={14} /></Link></div>{dashboard.courses.length ? <div className="course-timeline">{dashboard.courses.slice(0, 5).map((course) => <div className="timeline-row" key={course.id} data-testid={`course-row-${course.id}`}><span className="timeline-time">{formatTime(course.startsAt)}</span><span className="timeline-line" /><span className="timeline-info"><strong>{course.title}</strong><small>{course.instructor} · {course.room}</small></span><span className={`pill pill-${course.status}`}>{course.enrolled}/{course.capacity}</span></div>)}</div> : <div className="empty-inline"><CalendarDays size={18} /> Keine Kurse für heute.</div>}</div><div className="panel activity-panel"><div className="panel-head"><div><div className="eyebrow">Aus dem Workspace</div><h3>Letzte Aktivität</h3></div><Activity size={18} className="muted-icon" /></div>{dashboard.activities.length ? <div className="activity-list">{dashboard.activities.slice(0, 5).map((item) => <div className="activity-row" key={item.id} data-testid={`activity-row-${item.id}`}><span className={`activity-icon activity-${item.category}`}><Activity size={15} /></span><div><strong>{item.title}</strong><p>{item.description}</p><small>{timeAgo(item.happenedAt)}</small></div></div>)}</div> : <div className="empty-inline">Noch keine Aktivitäten.</div>}</div></div></>;
}

function MembersPage({ me }: { me: Me }) {
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [selected, setSelected] = useState<Member | null>(null);
  const membersQuery = useListMembers(search ? { search } : undefined, { query: { queryKey: getListMembersQueryKey(search ? { search } : undefined) } });
  const checkIn = useCreateCheckIn();
  const create = useCreateMember();
  const updateMember = useUpdateMember();
  const [form, setForm] = useState({ fullName: '', email: '', phone: '', membershipType: 'Standard', status: 'active' });
  const updateForm = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));
  const openCreate = () => { setSelected(null); setForm({ fullName: '', email: '', phone: '', membershipType: 'Standard', status: 'active' }); setModal('create'); };
  const openEdit = (member: Member) => { setSelected(member); setForm({ fullName: member.fullName, email: member.email, phone: member.phone || '', membershipType: member.membershipType, status: member.status }); setModal('edit'); };
  const submit = (e: React.FormEvent) => { e.preventDefault(); if (modal === 'create') create.mutate({ data: { ...form, studioId: me.studioId || 0, status: form.status as 'active' | 'trial' | 'paused' } }, { onSuccess: () => { client.invalidateQueries({ queryKey: getListMembersQueryKey() }); setModal(null); } }); else if (selected) updateMember.mutate({ id: selected.id, data: { ...form, phone: form.phone || null, status: form.status as 'active' | 'trial' | 'paused' } }, { onSuccess: () => { client.invalidateQueries({ queryKey: getListMembersQueryKey() }); setModal(null); } }); };
  const members = membersQuery.data || [];
  return <><PageHeader eyebrow={`${me.studioName || 'Workspace'} / Menschen`} title="Mitglieder" description="Behalte Beziehungen im Blick — nicht nur Datensätze." action={<button className="button button-dark" onClick={openCreate} data-testid="button-create-member"><Plus size={17} /> Mitglied anlegen</button>} /><div className="toolbar"><div className="input-search"><Search size={17} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nach Name, E-Mail oder Mitgliedsnummer suchen …" data-testid="input-member-search" /></div><button className="filter-button" data-testid="button-member-filter">Alle Status <ChevronDown size={15} /></button><span className="toolbar-count">{members.length} Mitglieder</span></div>{membersQuery.isLoading ? <LoadingBlock label="Mitglieder werden geladen" /> : membersQuery.isError ? <ErrorBlock retry={() => membersQuery.refetch()} /> : members.length === 0 ? <div className="empty-state" data-testid="status-members-empty"><div className="empty-icon"><Users size={22} /></div><h3>Noch keine Mitglieder</h3><p>Lege das erste Mitglied an, um deinen Studio-Tag zu starten.</p><button className="button button-dark" onClick={openCreate} data-testid="button-empty-create-member"><Plus size={16} /> Erstes Mitglied anlegen</button></div> : <div className="table-card"><div className="member-table-head"><span>Mitglied</span><span>Kontakt</span><span>Mitgliedschaft</span><span>Status</span><span>Letzter Check-in</span><span /></div>{members.map((member) => <div className="member-row" key={member.id} data-testid={`member-row-${member.id}`}><div className="member-name"><span className="avatar avatar-violet">{initials(member.fullName)}</span><span><strong>{member.fullName}</strong><small>seit {new Intl.DateTimeFormat('de-DE', { month: 'short', year: 'numeric' }).format(new Date(member.joinedAt))}</small></span></div><div className="member-contact"><strong>{member.email}</strong><small>{member.phone || 'Keine Telefonnummer'}</small></div><span className="membership-type">{member.membershipType}</span><span className={`status-label status-${member.status}`}><i />{member.status === 'active' ? 'Aktiv' : member.status === 'trial' ? 'Probetraining' : 'Pausiert'}</span><span className="last-checkin">{member.lastCheckIn ? timeAgo(member.lastCheckIn) : 'Noch nicht'}</span><div className="row-actions"><button className="icon-button" onClick={() => checkIn.mutate({ data: { memberId: member.id, studioId: member.studioId } }, { onSuccess: () => client.invalidateQueries({ queryKey: getListMembersQueryKey() }) })} title="Check-in" data-testid={`button-checkin-member-${member.id}`}><Check size={16} /></button><button className="icon-button" onClick={() => openEdit(member)} title="Bearbeiten" data-testid={`button-edit-member-${member.id}`}><Pencil size={16} /></button></div></div>)}</div>}{modal && <Modal title={modal === 'create' ? 'Neues Mitglied' : 'Mitglied bearbeiten'} onClose={() => setModal(null)}><form onSubmit={submit} className="modal-form"><TextField label="Vollständiger Name" name="member-name" value={form.fullName} onChange={updateForm('fullName')} /><TextField label="E-Mail-Adresse" name="member-email" value={form.email} onChange={updateForm('email')} type="email" /><TextField label="Telefon" name="member-phone" value={form.phone} onChange={updateForm('phone')} /><TextField label="Mitgliedschaft" name="member-membership" value={form.membershipType} onChange={updateForm('membershipType')} /><label className="field"><span>Status</span><select value={form.status} onChange={(e) => updateForm('status')(e.target.value)} data-testid="select-member-status"><option value="active">Aktiv</option><option value="trial">Probetraining</option><option value="paused">Pausiert</option></select></label><button className="button button-dark button-wide" disabled={create.isPending || updateMember.isPending} data-testid="button-save-member"><Check size={16} /> Speichern</button></form></Modal>}</>;
}

function CoursesPage({ me }: { me: Me }) {
  const client = useQueryClient();
  const query = useListCourses({ query: { queryKey: getListCoursesQueryKey() } });
  const create = useCreateCourse();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', instructor: '', startsAt: '', endsAt: '', capacity: '20', room: '' });
  const update = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));
  const submit = (e: React.FormEvent) => { e.preventDefault(); create.mutate({ data: { ...form, capacity: Number(form.capacity), studioId: me.studioId || 0, startsAt: new Date(form.startsAt).toISOString(), endsAt: new Date(form.endsAt).toISOString() } }, { onSuccess: () => { client.invalidateQueries({ queryKey: getListCoursesQueryKey() }); setOpen(false); } }); };
  const courses = query.data || [];
  return <><PageHeader eyebrow={`${me.studioName || 'Workspace'} / Rhythmus`} title="Kurse" description="Plane Energie, Räume und Plätze — an einem Ort." action={<button className="button button-dark" onClick={() => setOpen(true)} data-testid="button-create-course"><Plus size={17} /> Kurs planen</button>} />{query.isLoading ? <LoadingBlock label="Kursplan wird geladen" /> : query.isError ? <ErrorBlock retry={() => query.refetch()} /> : courses.length === 0 ? <div className="empty-state"><div className="empty-icon"><CalendarDays size={22} /></div><h3>Dein Kursplan ist noch leer</h3><p>Plane den ersten Kurs und gib deinem Studio-Rhythmus eine Form.</p><button className="button button-dark" onClick={() => setOpen(true)} data-testid="button-empty-create-course"><Plus size={16} /> Ersten Kurs planen</button></div> : <div className="course-grid">{courses.map((course: Course) => <div className="course-card" key={course.id} data-testid={`course-card-${course.id}`}><div className="course-accent" /><div className="course-card-top"><span className={`pill pill-${course.status}`}>{course.status === 'scheduled' ? 'Geplant' : course.status === 'full' ? 'Ausgebucht' : 'Abgesagt'}</span><button className="icon-button" data-testid={`button-course-menu-${course.id}`}><MoreHorizontal size={17} /></button></div><div className="course-time">{formatTime(course.startsAt)} <span>—</span> {formatTime(course.endsAt)}</div><h3>{course.title}</h3><p>{course.instructor} · {course.room}</p><div className="course-card-bottom"><span><Users size={15} /> {course.enrolled} / {course.capacity}</span><span className={course.enrolled / course.capacity > .8 ? 'warning-text' : 'positive-text'}>{Math.round((course.enrolled / course.capacity) * 100)}% belegt</span></div><div className="capacity-bar"><i style={{ width: `${Math.min(100, (course.enrolled / course.capacity) * 100)}%` }} /></div></div>)}</div>}{open && <Modal title="Neuen Kurs planen" onClose={() => setOpen(false)}><form onSubmit={submit} className="modal-form"><TextField label="Kursname" name="course-title" value={form.title} onChange={update('title')} placeholder="z. B. Yoga Flow" /><TextField label="Trainer:in" name="course-instructor" value={form.instructor} onChange={update('instructor')} /><div className="field-grid"><TextField label="Beginn" name="course-start" value={form.startsAt} onChange={update('startsAt')} type="datetime-local" /><TextField label="Ende" name="course-end" value={form.endsAt} onChange={update('endsAt')} type="datetime-local" /></div><div className="field-grid"><TextField label="Kapazität" name="course-capacity" value={form.capacity} onChange={update('capacity')} type="number" /><TextField label="Raum" name="course-room" value={form.room} onChange={update('room')} /></div><button className="button button-dark button-wide" disabled={create.isPending} data-testid="button-save-course"><Check size={16} /> Kurs speichern</button></form></Modal>}</>;
}

function TeamPage({ me }: { me: Me }) {
  const client = useQueryClient();
  const query = useListInvitations({ query: { queryKey: getListInvitationsQueryKey() } });
  const create = useCreateInvitation();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ email: '', role: 'studio_employee', studioId: String(me.studioId || '') });
  const invitations = query.data || [];
  const submit = (e: React.FormEvent) => { e.preventDefault(); create.mutate({ data: { email: form.email, role: form.role as Role, studioId: Number(form.studioId) } }, { onSuccess: () => { client.invalidateQueries({ queryKey: getListInvitationsQueryKey() }); setOpen(false); } }); };
  return <><PageHeader eyebrow={`${me.organizationName || 'Organisation'} / Zusammenarbeit`} title="Team" description="Die richtigen Menschen, mit der richtigen Verantwortung." action={<button className="button button-dark" onClick={() => setOpen(true)} data-testid="button-create-invitation"><Mail size={17} /> Einladung senden</button>} /><div className="team-intro"><div className="team-intro-icon"><ShieldCheck size={23} /></div><div><strong>Rollen geben Orientierung.</strong><p>Fiudia lädt jede Person automatisch in die passende Perspektive ein. Du vergibst nur Verantwortung — keine Zugriffsrechte per Hand.</p></div></div>{query.isLoading ? <LoadingBlock label="Team wird geladen" /> : query.isError ? <ErrorBlock retry={() => query.refetch()} /> : <div className="table-card invitation-table"><div className="member-table-head"><span>E-Mail</span><span>Rolle</span><span>Studio</span><span>Status</span><span>Gültig bis</span><span /></div>{invitations.length ? invitations.map((invite: Invitation) => <div className="member-row" key={invite.id} data-testid={`invitation-row-${invite.id}`}><div className="member-name"><span className="avatar avatar-mint"><Mail size={16} /></span><span><strong>{invite.email}</strong><small>Einladung #{invite.id}</small></span></div><span className="membership-type">{roleLabel(invite.role)}</span><span className="member-contact">{invite.studioName}</span><span className={`status-label status-${invite.status === 'pending' ? 'trial' : invite.status === 'accepted' ? 'active' : 'paused'}`}><i />{invite.status === 'pending' ? 'Ausstehend' : invite.status === 'accepted' ? 'Angenommen' : 'Abgelaufen'}</span><span className="last-checkin">{new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(invite.expiresAt))}</span><button className="icon-button" onClick={() => navigator.clipboard?.writeText(invite.inviteUrl)} data-testid={`button-copy-invitation-${invite.id}`}><ArrowRight size={16} /></button></div>) : <div className="empty-inline"><Users size={18} /> Noch keine Einladungen.</div>}</div>}{open && <Modal title="Teammitglied einladen" onClose={() => setOpen(false)}><form onSubmit={submit} className="modal-form"><TextField label="E-Mail-Adresse" name="invitation-email" value={form.email} onChange={(value) => setForm((f) => ({ ...f, email: value }))} type="email" placeholder="name@studio.de" /><label className="field"><span>Rolle</span><select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} data-testid="select-invitation-role"><option value="studio_employee">Studio-Team</option><option value="studio_manager">Studioleitung</option>{me.role === 'district_manager' && <option value="district_manager">Bezirksleitung</option>}</select></label><button className="button button-dark button-wide" disabled={create.isPending} data-testid="button-send-invitation"><Mail size={16} /> Einladung senden</button></form></Modal>}</>;
}

function InvitePage() {
  const [, setLocation] = useLocation();
  const [, params] = useRoute('/invite/:token');
  const mutation = useAcceptInvitation();
  const { isSignedIn } = useAuth();
  const accept = () => { if (!isSignedIn) { setLocation(`/sign-in?redirect_url=${window.location.pathname}`); return; } if (params?.token) mutation.mutate({ token: params.token }, { onSuccess: () => setLocation('/dashboard') }); };
  return <div className="invite-page"><Brand /><div className="invite-card"><div className="invite-symbol"><Users size={24} /></div><div className="eyebrow">Deine Einladung</div><h1>Gemeinsam wird<br /><em>mehr daraus.</em></h1><p>Du wurdest eingeladen, einem Fiudia-Workspace beizutreten. Nimm deinen Platz im Studio ein.</p><button className="button button-dark button-wide" onClick={accept} disabled={mutation.isPending} data-testid="button-accept-invitation">{mutation.isPending ? 'Einladung wird angenommen …' : isSignedIn ? 'Einladung annehmen' : 'Anmelden und beitreten'} <ArrowRight size={17} /></button>{mutation.isError && <p className="form-error">Diese Einladung ist nicht mehr gültig. Bitte frage die Studioleitung nach einem neuen Link.</p>}</div></div>;
}

function SettingsPage() {
  const { user } = useUser();
  const { openUserProfile } = useClerk();
  return <><PageHeader eyebrow="Workspace / Einstellungen" title="Einstellungen" description="Deine persönlichen Details und die Sprache deines Workspace." /><div className="settings-card"><div className="settings-avatar avatar">{initials(user?.fullName || user?.firstName || 'F')}</div><div><h3>{user?.fullName || user?.firstName || 'Fiudia Nutzer'}</h3><p>{user?.primaryEmailAddress?.emailAddress || 'Dein Konto'}</p></div><button className="button button-outline" onClick={() => openUserProfile()} data-testid="button-open-profile">Profil verwalten</button></div></>;
}

function ProtectedRoute({ page }: { page: 'dashboard' | 'members' | 'courses' | 'team' | 'settings' }) {
  return <AuthenticatedData>{(me) => page === 'dashboard' ? <DashboardPage me={me} /> : page === 'members' ? <MembersPage me={me} /> : page === 'courses' ? <CoursesPage me={me} /> : page === 'team' ? <TeamPage me={me} /> : <SettingsPage />}</AuthenticatedData>;
}

function NotFoundPage() {
  return <div className="not-found"><Brand /><div className="empty-icon"><CircleHelp size={24} /></div><h1>Diese Seite ist nicht im Plan.</h1><p>Vielleicht hat sie gerade einen freien Tag.</p><Link href="/" className="button button-dark" data-testid="link-not-found-home">Zur Startseite</Link></div>;
}

function Router() {
  return <Switch><Route path="/" component={HomeRedirect} /><Route path="/sign-in/*?" component={SignInPage} /><Route path="/sign-up/*?" component={SignUpPage} /><Route path="/onboarding" component={OnboardingPage} /><Route path="/invite/:token" component={InvitePage} /><Route path="/dashboard"><ProtectedRoute page="dashboard" /></Route><Route path="/members"><ProtectedRoute page="members" /></Route><Route path="/courses"><ProtectedRoute page="courses" /></Route><Route path="/team"><ProtectedRoute page="team" /></Route><Route path="/settings"><ProtectedRoute page="settings" /></Route><Route component={NotFoundPage} /></Switch>;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  useEffect(() => addListener(({ user }) => { if (!user) client.clear(); }), [addListener, client]);
  return null;
}

function ClerkApp() {
  const [, setLocation] = useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={{ signIn: { start: { title: 'Willkommen zurück', subtitle: 'Melde dich an, um weiterzumachen' } }, signUp: { start: { title: 'Erstelle deinen Workspace', subtitle: 'Starte mit Fiudia' } } }} routerPush={(to: string) => setLocation(stripBase(to))} routerReplace={(to: string) => setLocation(stripBase(to), { replace: true })}><QueryClientProvider client={queryClient}><ClerkQueryClientCacheInvalidator /><Router /><Toaster /></QueryClientProvider></ClerkProvider>;
}

function App() {
  return <ErrorBoundary><WouterRouter base={basePath}><ClerkApp /></WouterRouter></ErrorBoundary>;
}

export default App;