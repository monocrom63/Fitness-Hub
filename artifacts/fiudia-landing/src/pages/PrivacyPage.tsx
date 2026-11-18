import { useEffect } from 'react';

type PrivacyPageProps = {
  homeHref: string;
};

const processors = [
  {
    name: 'Replit',
    purpose: 'Hosting der Anwendung sowie Bereitstellung der Datenbank und technischer Infrastruktur.',
    href: 'https://replit.com/privacy-policy',
  },
  {
    name: 'Clerk',
    purpose: 'Anmeldung, Authentifizierung und Verwaltung von Kontositzungen.',
    href: 'https://clerk.com/legal/privacy',
  },
  {
    name: 'Google',
    purpose: 'Anmeldung, wenn Google als Login-Methode verwendet wird, und Bereitstellung der auf der Landingpage eingebundenen Google Fonts.',
    href: 'https://policies.google.com/privacy',
  },
  {
    name: 'Stripe',
    purpose: 'Abwicklung von Zahlungen und Verwaltung von Zahlungs- oder Abonnementstatus. Zahlungsdaten werden durch Stripe verarbeitet.',
    href: 'https://stripe.com/privacy',
  },
  {
    name: 'Resend',
    purpose: 'Versand von transaktionalen E-Mails, zum Beispiel Einladungen und Systemnachrichten.',
    href: 'https://resend.com/legal/privacy-policy',
  },
  {
    name: 'OneSignal',
    purpose: 'Zustellung von Push-Nachrichten sowie Verarbeitung der dafür erforderlichen Geräte- und Zustellinformationen.',
    href: 'https://onesignal.com/privacy_policy',
  },
];

function PrivacyPage({ homeHref }: PrivacyPageProps) {
  useEffect(() => {
    document.title = 'Datenschutz | Fiudia';
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    description?.setAttribute(
      'content',
      'Informationen zur Verarbeitung personenbezogener Daten bei Fiudia.',
    );
    document.querySelector<HTMLMetaElement>('meta[property="og:title"]')
      ?.setAttribute('content', 'Datenschutz | Fiudia');
    document.querySelector<HTMLMetaElement>('meta[property="og:description"]')
      ?.setAttribute(
        'content',
        'Informationen zur Verarbeitung personenbezogener Daten bei Fiudia.',
      );
  }, []);

  return (
    <main className="privacy-shell">
      <header className="privacy-header">
        <a className="brand" href={homeHref} aria-label="Fiudia – zur Startseite">
          <span className="brand-symbol">f</span>
          <span>fiudia</span>
        </a>
        <a className="privacy-home-link" href={homeHref}>Zur Landingpage</a>
      </header>

      <article className="privacy-content">
        <p className="privacy-kicker">Fiudia Fitness Hub GmbH</p>
        <h1>Datenschutzerklärung</h1>
        <p className="privacy-updated">Stand: 18. November 2026</p>

        <aside className="privacy-disclaimer" role="note">
          <strong>Hinweis:</strong> Diese Datenschutzerklärung ist ein Informationsentwurf und
          keine Rechtsberatung. Bitte vor Veröffentlichung die tatsächlichen Datenflüsse,
          Anbietervereinbarungen und Pflichtangaben rechtlich prüfen lassen.
        </aside>

        <section>
          <h2>1. Verantwortlicher</h2>
          <p>
            Verantwortlich für die Verarbeitung personenbezogener Daten im Zusammenhang mit
            der Fiudia-Website und dem Fiudia-Dienst ist:
          </p>
          <address>
            Fiudia Fitness Hub GmbH<br />
            Martin-Luther-Strasse 120<br />
            10825 Berlin, Deutschland<br />
            E-Mail: <a href="mailto:info@fiudia.de">info@fiudia.de</a>
          </address>
        </section>

        <section>
          <h2>2. Für wen diese Erklärung gilt</h2>
          <p>
            Diese Erklärung beschreibt die Verarbeitung auf der öffentlichen Landingpage und
            bei der Nutzung von Fiudia durch Studioverantwortliche, Mitarbeitende und
            Mitglieder. Für Daten, die ein Studio in seinem Fiudia-Arbeitsbereich verwaltet,
            bestimmt das jeweilige Studio grundsätzlich die Zwecke der Verarbeitung. Fiudia
            verarbeitet solche Daten zur Bereitstellung des Dienstes nach den Weisungen des
            Studios. Soweit erforderlich, erfolgt dies auf Grundlage einer Vereinbarung zur
            Auftragsverarbeitung. Die Datenschutzhinweise des jeweiligen Studios gelten
            zusätzlich.
          </p>
        </section>

        <section>
          <h2>3. Welche Daten wir verarbeiten</h2>
          <ul>
            <li>
              <strong>Konten und Anmeldung:</strong> Name, E-Mail-Adresse, Anmeldedaten,
              Studiozugehörigkeit, Rolle und Kontoeinstellungen.
            </li>
            <li>
              <strong>Studioverwaltung:</strong> von Studios eingegebene Mitglieder- und
              Vertragsinformationen, Kurs- und Planungsdaten, Kommunikationspräferenzen und
              Einwilligungsnachweise.
            </li>
            <li>
              <strong>Kommunikation:</strong> E-Mail-Adresse, gegebenenfalls Telefonnummer,
              Inhalt und Zustellstatus von Systemnachrichten sowie technische Kennungen für
              Push-Nachrichten.
            </li>
            <li>
              <strong>Zahlungen:</strong> Zahlungs- und Abonnementstatus sowie
              Transaktionsinformationen. Zahlungsdaten werden durch Stripe verarbeitet;
              Fiudia erhält die für die Verwaltung des Dienstes erforderlichen Informationen.
            </li>
            <li>
              <strong>Technische Daten:</strong> IP-Adresse, Zeitpunkt und Ziel eines
              Seitenaufrufs, Browser- und Geräteinformationen sowie Sicherheits- und
              Fehlerprotokolle, soweit sie beim Betrieb anfallen.
            </li>
          </ul>
          <p>
            Auf der öffentlichen Landingpage gibt es nach dem derzeitigen Stand keine
            Analyse- oder Werbe-Tools. Die Seite lädt jedoch Schriftarten von Google Fonts;
            dabei können technische Verbindungsdaten, insbesondere die IP-Adresse, an Google
            übermittelt werden.
          </p>
        </section>

        <section>
          <h2>4. Zwecke und Rechtsgrundlagen</h2>
          <p>Wir verarbeiten Daten insbesondere, um:</p>
          <ul>
            <li>Fiudia bereitzustellen, Konten zu verwalten und Nutzer anzumelden;</li>
            <li>Studios bei der Organisation von Teams, Mitgliedern, Kursen und Verträgen zu unterstützen;</li>
            <li>Zahlungen und Abonnements zu verwalten sowie Anfragen zu beantworten;</li>
            <li>Systemnachrichten und aktivierte Push-Mitteilungen zuzustellen;</li>
            <li>den sicheren und zuverlässigen Betrieb zu gewährleisten und gesetzliche Pflichten zu erfüllen.</li>
          </ul>
          <p>
            Rechtsgrundlage ist je nach Vorgang die Vertragserfüllung (Art. 6 Abs. 1 lit. b
            DSGVO), eine rechtliche Verpflichtung (Art. 6 Abs. 1 lit. c DSGVO), eine
            Einwilligung (Art. 6 Abs. 1 lit. a DSGVO) oder unser berechtigtes Interesse an
            einem sicheren Betrieb und der Beantwortung von Anfragen (Art. 6 Abs. 1 lit. f
            DSGVO). Eine Einwilligung kann jederzeit mit Wirkung für die Zukunft widerrufen
            werden.
          </p>
        </section>

        <section>
          <h2>5. Empfänger und eingesetzte Anbieter</h2>
          <p>
            Wir übermitteln Daten nur, soweit dies für die genannten Zwecke erforderlich ist.
            Dabei kommen insbesondere folgende Anbieter zum Einsatz:
          </p>
          <ul>
            {processors.map((processor) => (
              <li key={processor.name}>
                <strong>{processor.name}:</strong> {processor.purpose}{' '}
                <a href={processor.href} target="_blank" rel="noreferrer">
                  Datenschutzhinweise des Anbieters
                </a>
              </li>
            ))}
          </ul>
          <p>
            Der Versand von SMS über Twilio ist derzeit geplant, aber noch nicht aktiviert.
            Vor einer Aktivierung werden die dazugehörigen Datenflüsse und Anbieterangaben
            ergänzt. Je nach Anbieter kann eine Verarbeitung außerhalb des Europäischen
            Wirtschaftsraums stattfinden. In diesen Fällen müssen die jeweils erforderlichen
            Garantien, etwa Angemessenheitsbeschlüsse oder Standardvertragsklauseln, gelten.
          </p>
        </section>

        <section>
          <h2>6. Cookies und ähnliche Technologien</h2>
          <p>
            Für Anmeldung und grundlegende Funktionen können erforderliche Sitzungs- und
            Funktionstechnologien verwendet werden. Nach dem derzeitigen Stand setzt die
            Landingpage keine Analyse- oder Werbe-Cookies ein. Die externe Einbindung von
            Google Fonts ist in Abschnitt 3 beschrieben. Weitere nicht notwendige
            Technologien werden nur eingesetzt, wenn die erforderliche Rechtsgrundlage
            vorliegt.
          </p>
        </section>

        <section>
          <h2>7. Speicherdauer</h2>
          <p>
            Kontodaten werden während der Vertragslaufzeit benötigt. Nach Vertragsende
            werden sie grundsätzlich innerhalb von drei Monaten gelöscht oder anonymisiert.
            Daten, die gesetzlichen Aufbewahrungspflichten unterliegen oder zur Klärung
            offener Ansprüche benötigt werden, können für die jeweils erforderliche Dauer
            länger gespeichert werden. Technische Sicherungskopien können nach den
            Löschzyklen der eingesetzten Systeme auslaufen.
          </p>
        </section>

        <section>
          <h2>8. Datensicherheit</h2>
          <p>
            Wir setzen angemessene technische und organisatorische Maßnahmen ein, um Daten
            vor Verlust, unberechtigtem Zugriff und unzulässiger Offenlegung zu schützen.
            Innerhalb von Fiudia richten sich Zugriffe nach den für das jeweilige Studio und
            die jeweilige Rolle vorgesehenen Berechtigungen.
          </p>
        </section>

        <section>
          <h2>9. Rechte betroffener Personen</h2>
          <p>
            Im Rahmen der gesetzlichen Voraussetzungen haben Sie das Recht auf Auskunft,
            Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und
            Widerspruch. Haben Sie eine Einwilligung erteilt, können Sie diese jederzeit für
            die Zukunft widerrufen. Zur Ausübung Ihrer Rechte schreiben Sie an{' '}
            <a href="mailto:info@fiudia.de">info@fiudia.de</a>. Sie haben außerdem das Recht,
            sich bei einer Datenschutz-Aufsichtsbehörde zu beschweren.
          </p>
          <p>
            Wenn sich Ihre Anfrage auf Mitglieds- oder Vertragsdaten bezieht, die ein Studio
            in Fiudia verwaltet, wenden Sie sich bitte auch an das jeweilige Studio. Es
            entscheidet grundsätzlich über diese Daten; Fiudia unterstützt das Studio bei
            der Bearbeitung Ihrer Anfrage.
          </p>
        </section>

        <section>
          <h2>10. Mindestalter</h2>
          <p>
            Fiudia-Konten dürfen ab 18 Jahren angelegt werden. Studios müssen bei Daten
            ihrer Mitglieder, insbesondere bei Minderjährigen, die jeweils geltenden
            gesetzlichen Anforderungen beachten und erforderliche Berechtigungen einholen.
          </p>
        </section>

        <section>
          <h2>11. Änderungen dieser Erklärung</h2>
          <p>
            Wir aktualisieren diese Erklärung, wenn sich die Verarbeitung oder die
            rechtlichen Anforderungen ändern. Die aktuelle Fassung ist jederzeit auf dieser
            Seite abrufbar.
          </p>
        </section>
      </article>

      <footer className="privacy-footer">
        <a href={homeHref}>Zur Fiudia-Landingpage</a>
        <a href="mailto:info@fiudia.de">Datenschutzkontakt</a>
      </footer>
    </main>
  );
}

export default PrivacyPage;
