import { useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronRight,
  ClipboardList,
  Dumbbell,
  Heart,
  Layers3,
  MapPin,
  Menu,
  UsersRound,
  X,
} from 'lucide-react';
import studioTraining from '@assets/download_97d4b9a2-1b0f-46ba-969e-17fe59bc8d35_1793002687604.webp';

const roles = [
  {
    number: '01',
    title: 'Bezirksleitung',
    copy: 'Standorte zusammen denken. Verstehen, was vor Ort passiert — und dort unterstützen, wo es gebraucht wird.',
    Icon: MapPin,
  },
  {
    number: '02',
    title: 'Studioleitung',
    copy: 'Mitglieder, Team und Kursplan für das eigene Studio an einem Ort zusammenbringen.',
    Icon: Layers3,
  },
  {
    number: '03',
    title: 'Studio-Team',
    copy: 'Wissen, was heute ansteht. Und mehr Aufmerksamkeit für die Menschen im Studio haben.',
    Icon: Heart,
  },
];

const workday = [
  {
    number: '01',
    title: 'Menschen im Blick',
    copy: 'Mitgliederprofile und Mitgliedschaften gehören zusammen — damit das Team die wichtigen Informationen zum richtigen Moment findet.',
    Icon: UsersRound,
  },
  {
    number: '02',
    title: 'Kurse, die zusammenpassen',
    copy: 'Kurspläne und Kursleitungen zentral organisieren. Änderungen bleiben dort sichtbar, wo sie für den Studioalltag zählen.',
    Icon: CalendarDays,
  },
  {
    number: '03',
    title: 'Abläufe mit Überblick',
    copy: 'Aufgaben und Hinweise bekommen einen klaren Platz. So kann jedes Teammitglied den eigenen nächsten Schritt erkennen.',
    Icon: ClipboardList,
  },
];

function Brand({ light = false }: { light?: boolean }) {
  return (
    <a className={`brand${light ? ' brand-light' : ''}`} href="#top" aria-label="Fiudia – zur Startseite">
      <span className="brand-symbol">f</span>
      <span>fiudia</span>
    </a>
  );
}

function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  return (
    <main className="site-shell" id="top">
      <header className="topbar">
        <Brand />
        <button
          className="menu-toggle"
          type="button"
          aria-label={menuOpen ? 'Menü schließen' : 'Menü öffnen'}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          data-testid="button-toggle-menu"
        >
          {menuOpen ? <X size={23} /> : <Menu size={23} />}
        </button>
        <nav className={`nav-links${menuOpen ? ' is-open' : ''}`} aria-label="Hauptnavigation">
          <a href="#perspektiven" onClick={closeMenu}>Für wen</a>
          <a href="#alltag" onClick={closeMenu}>Der Studioalltag</a>
          <a href="#funktionen" onClick={closeMenu}>Was zusammenkommt</a>
          <a className="button button-quiet" href="/sign-in" data-testid="link-sign-in">Anmelden <ArrowRight size={15} /></a>
        </nav>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <div className="eyebrow">Ein klarer Platz für alles, was bewegt</div>
          <h1 id="hero-title">Dein Studio.<br /><em>Dein Rhythmus.</em></h1>
          <p>Fiudia bringt Studio-Teams, Mitglieder, Kurse und tägliche Abläufe in einem Workspace zusammen — passend zu deiner Rolle.</p>
          <div className="hero-actions">
            <a className="button" href="/sign-up" data-testid="link-sign-up">Fiudia kennenlernen <ArrowRight size={17} /></a>
            <a className="simple-link" href="#perspektiven" data-testid="link-explore">So funktioniert’s <ArrowDown size={15} /></a>
          </div>
          <div className="hero-note"><span /> Für Menschen, die Studios in Bewegung halten.</div>
        </div>
        <div className="hero-visual" aria-label="Training im Studio">
          <div className="hero-photo">
            <img src={studioTraining} alt="Sportlerin beim Training am Kabelzug im Studio" />
            <div className="photo-wash" />
            <div className="photo-caption">
              <small>Mehr Raum fürs Wesentliche</small>
              <strong>Der Alltag läuft.<br />Das Team auch.</strong>
            </div>
          </div>
          <div className="photo-sticker"><span>klar<br />verbunden</span><small>Fiudia</small></div>
          <span className="hero-index">01 — 03</span>
        </div>
      </section>

      <div className="strip" aria-label="Fiudia verbindet">
        <span>Menschen</span><i /><span>Studios</span><i /><span>Kurse</span><i /><span>Tägliche Abläufe</span>
      </div>

      <section className="section roles-section" id="perspektiven">
        <div className="roles-heading">
          <div>
            <div className="section-kicker">01 / Eine Plattform. Viele Perspektiven.</div>
            <h2 className="section-title">Eine klare Sicht.<br /><em>Für jede Rolle.</em></h2>
          </div>
          <p className="section-lede">Gute Zusammenarbeit beginnt damit, dass alle das sehen, was sie für ihre Arbeit brauchen. Fiudia richtet den Blick auf Verantwortung, Ort und Tagesgeschäft.</p>
        </div>
        <div className="roles-grid">
          {roles.map(({ number, title, copy, Icon }) => (
            <article className="role-item" key={number}>
              <span className="role-number">{number} / PERSPEKTIVE</span>
              <Icon className="role-symbol" size={22} strokeWidth={1.5} />
              <h3>{title}</h3>
              <p>{copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section flow-section" id="alltag">
        <div className="flow-intro">
          <div>
            <div className="section-kicker">02 / Vom ersten Hallo bis zum letzten Kurs</div>
            <h2 className="section-title">Der Studioalltag,<br /><em>in einem natürlichen Flow.</em></h2>
          </div>
          <p className="section-lede">Weniger zwischen Listen und Zuständigkeiten wechseln. Mehr Überblick über das, was heute wichtig ist.</p>
        </div>
        <div className="flow-list">
          {workday.map(({ number, title, copy, Icon }) => (
            <article className="flow-row" key={number}>
              <span className="flow-no">{number}</span>
              <h3>{title}</h3>
              <p>{copy}</p>
              <Icon className="flow-icon" size={21} strokeWidth={1.6} />
            </article>
          ))}
        </div>
      </section>

      <section className="section feature-section" id="funktionen">
        <div className="feature-layout">
          <div className="feature-sticky">
            <div className="section-kicker">03 / Alles am richtigen Platz</div>
            <h2 className="section-title">Was dein Studio braucht.<br /><em>Ohne Umwege.</em></h2>
            <p className="section-lede">Die zentralen Bereiche der Studioarbeit greifen ineinander, statt nebeneinander zu liegen.</p>
            <a className="simple-link" href="/sign-up" data-testid="link-feature-sign-up">Workspace ansehen <ChevronRight size={16} /></a>
          </div>
          <div className="feature-cards">
            <article className="feature-card">
              <span className="feature-icon"><UsersRound size={21} /></span>
              <h3>Mitglieder</h3>
              <p>Profile und Mitgliedschaften an einem nachvollziehbaren Ort verwalten.</p>
            </article>
            <article className="feature-card">
              <span className="feature-icon"><CalendarDays size={21} /></span>
              <h3>Kurse</h3>
              <p>Kurspläne und Kursleitungen übersichtlich für den Alltag organisieren.</p>
            </article>
            <article className="feature-card">
              <span className="feature-icon"><Dumbbell size={21} /></span>
              <h3>Studios & Teams</h3>
              <p>Zusammenarbeit über Standorte und unterschiedliche Rollen hinweg ermöglichen.</p>
            </article>
            <article className="feature-card">
              <span className="feature-icon"><Check size={21} /></span>
              <h3>Tägliche Arbeit</h3>
              <p>Aufgaben, Hinweise und nächste Schritte an einer Stelle bündeln.</p>
            </article>
          </div>
        </div>
      </section>

      <section className="closing">
        <div>
          <div className="section-kicker">Ein guter Tag beginnt mit Überblick.</div>
          <h2>Weniger suchen.<br />Mehr <em>bewegen.</em></h2>
        </div>
        <div className="closing-copy">
          <p>Bring die wichtigen Teile deines Studioalltags zusammen — mit einem Workspace, der sich an den Menschen orientiert, die ihn nutzen.</p>
          <a className="button button-light" href="/sign-up" data-testid="link-closing-sign-up">Mit Fiudia starten <ArrowRight size={17} /></a>
        </div>
      </section>

      <footer className="footer">
        <Brand light />
        <span className="footer-note">Organisationen sind verschieden. Wir auch.</span>
        <div className="footer-links">
          <a href="#top">Zurück nach oben</a>
          <a href="/sign-in">Anmelden</a>
        </div>
      </footer>
    </main>
  );
}

export default App;
