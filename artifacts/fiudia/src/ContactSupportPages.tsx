import { ArrowUpRight, BookOpen, Bug, Lightbulb, Mail, MessageCircle, ShieldCheck, UserRound, Users } from 'lucide-react';

const cardStyle = {
  border: '1px solid hsl(var(--card-border))',
  borderRadius: 15,
  background: 'hsl(var(--card))',
  boxShadow: '0 8px 24px rgba(32,41,61,.035)',
};

function EmailAction({ subject, label, icon: Icon = ArrowUpRight, testId }: {
  subject?: string;
  label: string;
  icon?: typeof ArrowUpRight;
  testId: string;
}) {
  const href = `mailto:mail@fiudia.com${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`;
  return <a className="button button-dark" href={href} data-testid={testId}>
    <Icon size={16} aria-hidden="true" />{label}
  </a>;
}

export function ContactPage() {
  return <div>
    <header className="page-header">
      <div>
        <div className="eyebrow">Fiudia / Kontakt</div>
        <h1>Wir sind erreichbar.</h1>
        <p>Fragen zur Zusammenarbeit oder zu Fiudia? Schreib uns direkt.</p>
      </div>
    </header>

    <section aria-labelledby="contact-email-heading" style={{ ...cardStyle, position: 'relative', overflow: 'hidden', padding: 'clamp(24px, 5vw, 42px)', maxWidth: 880 }}>
      <div aria-hidden="true" style={{ position: 'absolute', width: 240, height: 240, right: -88, top: -105, borderRadius: '50%', background: 'rgba(200,187,255,.22)' }} />
      <div style={{ position: 'relative', maxWidth: 620 }}>
        <span style={{ display: 'grid', placeItems: 'center', width: 48, height: 48, borderRadius: 14, marginBottom: 24, background: '#eeeaff', color: '#7567b8' }}>
          <Mail size={22} aria-hidden="true" />
        </span>
        <div className="eyebrow">Der direkte Weg</div>
        <h2 id="contact-email-heading" style={{ margin: '8px 0 10px', fontFamily: 'var(--font-serif)', fontSize: 'clamp(1.7rem, 3vw, 2.35rem)', letterSpacing: '-.06em', lineHeight: 1.05 }}>Eine Nachricht genügt.</h2>
        <p style={{ maxWidth: 500, margin: '0 0 23px', color: 'hsl(var(--muted-foreground))', fontSize: '.85rem', lineHeight: 1.7 }}>
          Erzähl uns kurz, worum es geht. So können wir deine Anfrage besser einordnen und gezielt darauf eingehen.
        </p>
        <EmailAction label="E-Mail an Fiudia" testId="link-contact-email" />
        <p className="form-hint" style={{ margin: '13px 0 0' }}>
          <a href="mailto:mail@fiudia.com" data-testid="link-contact-address" style={{ color: '#7567b8', fontWeight: 700 }}>mail@fiudia.com</a>
        </p>
      </div>
    </section>

    <section aria-labelledby="contact-context-heading" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 270px), 1fr))', gap: 16, maxWidth: 880, marginTop: 18 }}>
      <article className="settings-card" style={{ ...cardStyle, alignItems: 'flex-start', padding: 22 }}>
        <span style={{ display: 'grid', placeItems: 'center', flex: '0 0 40px', width: 40, height: 40, borderRadius: 12, background: '#eaf5f1', color: '#39856f' }}><MessageCircle size={18} aria-hidden="true" /></span>
        <div>
          <h3 id="contact-context-heading">Damit wir dir helfen können</h3>
          <p>Ein paar Details machen den Einstieg leichter:</p>
          <ul style={{ margin: '12px 0 0', paddingLeft: 18, color: 'hsl(var(--muted-foreground))', fontSize: '.75rem', lineHeight: 1.8 }}>
            <li>dein Name und Studio oder Organisation</li>
            <li>worum es geht und was du erreichen möchtest</li>
            <li>bei Fragen zur App: betroffener Bereich und Schritte</li>
          </ul>
        </div>
      </article>
      <article className="settings-card" style={{ ...cardStyle, alignItems: 'flex-start', padding: 22 }}>
        <span style={{ display: 'grid', placeItems: 'center', flex: '0 0 40px', width: 40, height: 40, borderRadius: 12, background: '#fff2df', color: '#a06a27' }}><ShieldCheck size={18} aria-hidden="true" /></span>
        <div>
          <h3>Bitte keine sensiblen Daten</h3>
          <p>Schick uns keine Passwörter oder unnötigen persönlichen Mitgliederdaten. Beschreibe das Anliegen möglichst allgemein.</p>
        </div>
      </article>
    </section>
  </div>;
}

const faqs = [
  {
    id: 'signin',
    icon: UserRound,
    title: 'Anmeldung und Einladungen',
    answer: 'Prüfe bei einer Einladung zuerst, ob du dich mit der eingeladenen E-Mail-Adresse anmeldest. Wenn der Link nicht funktioniert, bitte die Studioleitung, die Einladung zu prüfen oder erneut einzuladen. Bei Problemen mit der Anmeldung beschreibe in deiner Nachricht, an welcher Stelle du nicht weiterkommst.',
  },
  {
    id: 'courses',
    icon: BookOpen,
    title: 'Kurse und Kursplanung',
    answer: 'Öffne den Bereich „Kurse“, um den Kursplan deines Workspaces anzusehen. Wenn ein Kurs fehlt oder Angaben nicht stimmen, nenne bitte Studio, Kurstitel sowie Datum und ungefähre Uhrzeit. So lässt sich die Frage besser zuordnen.',
  },
  {
    id: 'members',
    icon: Users,
    title: 'Mitgliederdaten und Verträge',
    answer: 'Mitgliederdaten und Vertragsangaben sind nur für berechtigte Rollen sichtbar und bearbeitbar. Wende dich bei fehlenden Berechtigungen an die Studioleitung. Wenn ein Eintrag unklar ist, teile in deiner Nachricht nur die nötigen Angaben mit und vermeide sensible Daten.',
  },
  {
    id: 'issue',
    icon: Bug,
    title: 'Ein technisches Problem melden',
    answer: 'Beschreibe, was du gerade tun wolltest, was stattdessen passiert ist und welche Schritte zum Problem führen. Ergänze den betroffenen Bereich und – falls hilfreich – Gerät und Browser. Screenshots können helfen; schwärze darauf persönliche oder vertrauliche Daten.',
  },
];

export function SupportPage() {
  return <div>
    <header className="page-header">
      <div>
        <div className="eyebrow">Fiudia / Hilfe</div>
        <h1>Hilfe, wenn’s hakt.</h1>
        <p>Kurze Antworten für deinen Arbeitsalltag – und der passende Kontakt, wenn du mehr brauchst.</p>
      </div>
    </header>

    <section aria-labelledby="support-faq-heading" style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 13 }}>
        <div>
          <div className="eyebrow">Gut zu wissen</div>
          <h2 id="support-faq-heading" style={{ margin: '6px 0 0', fontFamily: 'var(--font-serif)', fontSize: '1.5rem', letterSpacing: '-.05em' }}>Häufige Fragen</h2>
        </div>
        <span style={{ color: 'hsl(var(--muted-foreground))', fontSize: '.72rem' }}>Wähle ein Thema zum Öffnen</span>
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {faqs.map(({ id, icon: Icon, title, answer }) => <details key={id} style={{ ...cardStyle, overflow: 'hidden' }} data-testid={`faq-${id}`}>
          <summary style={{ display: 'flex', alignItems: 'center', gap: 13, minHeight: 70, padding: '15px 19px', cursor: 'pointer', listStyle: 'none' }}>
            <span style={{ display: 'grid', placeItems: 'center', flex: '0 0 38px', width: 38, height: 38, borderRadius: 11, background: '#f0edff', color: '#7567b8' }}><Icon size={18} aria-hidden="true" /></span>
            <span style={{ flex: 1, color: 'hsl(var(--foreground))', fontSize: '.84rem', fontWeight: 700 }}>{title}</span>
            <span aria-hidden="true" style={{ color: '#7567b8', fontSize: '1.2rem' }}>+</span>
          </summary>
          <p style={{ margin: '0 20px 20px 70px', maxWidth: 740, color: 'hsl(var(--muted-foreground))', fontSize: '.78rem', lineHeight: 1.75 }}>{answer}</p>
        </details>)}
      </div>
    </section>

    <section aria-labelledby="support-contact-heading" style={{ maxWidth: 900, marginTop: 30 }}>
      <div className="eyebrow">Noch Fragen?</div>
      <h2 id="support-contact-heading" style={{ margin: '6px 0 14px', fontFamily: 'var(--font-serif)', fontSize: '1.5rem', letterSpacing: '-.05em' }}>Schreib uns, worum es geht.</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 }}>
        <SupportAction icon={Mail} title="Allgemeine Hilfe" description="Eine Frage oder du kommst nicht weiter?" subject="Fiudia Support" testId="link-support-general" />
        <SupportAction icon={Bug} title="Technisches Problem" description="Melde einen Fehler mit den nötigen Details." subject="Fiudia Bugreport" testId="link-support-bug" />
        <SupportAction icon={Lightbulb} title="Idee teilen" description="Was würde deinen Alltag leichter machen?" subject="Fiudia Feature-Idee" testId="link-support-feature" />
      </div>
      <p className="form-hint" style={{ margin: '12px 0 0' }}>Alle Nachrichten gehen an <a href="mailto:mail@fiudia.com" data-testid="link-support-email-address" style={{ color: '#7567b8', fontWeight: 700 }}>mail@fiudia.com</a>.</p>
    </section>
  </div>;
}

function SupportAction({ icon: Icon, title, description, subject, testId }: {
  icon: typeof Mail;
  title: string;
  description: string;
  subject: string;
  testId: string;
}) {
  return <a href={`mailto:mail@fiudia.com?subject=${encodeURIComponent(subject)}`} data-testid={testId}
    style={{ ...cardStyle, display: 'grid', gridTemplateColumns: '34px 1fr 18px', alignItems: 'center', gap: 12, padding: 16, color: 'inherit', textDecoration: 'none', transition: 'transform .2s ease, border-color .2s ease' }}>
    <span style={{ display: 'grid', placeItems: 'center', width: 34, height: 34, borderRadius: 10, background: '#f0edff', color: '#7567b8' }}><Icon size={17} aria-hidden="true" /></span>
    <span style={{ minWidth: 0 }}>
      <strong style={{ display: 'block', fontSize: '.77rem' }}>{title}</strong>
      <span style={{ display: 'block', marginTop: 4, color: 'hsl(var(--muted-foreground))', fontSize: '.68rem', lineHeight: 1.45 }}>{description}</span>
    </span>
    <ArrowUpRight size={16} aria-hidden="true" style={{ color: '#7567b8' }} />
  </a>;
}
