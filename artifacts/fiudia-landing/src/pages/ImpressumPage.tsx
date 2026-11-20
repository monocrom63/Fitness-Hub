import { useEffect } from 'react';

type ImpressumPageProps = {
  homeHref: string;
  privacyHref: string;
};

function ImpressumPage({ homeHref, privacyHref }: ImpressumPageProps) {
  useEffect(() => {
    document.title = 'Impressum | Fiudia';
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    description?.setAttribute(
      'content',
      'Impressum und Kontaktangaben der Fiudia Fitness Hub GmbH i. G.',
    );
    document.querySelector<HTMLMetaElement>('meta[property="og:title"]')
      ?.setAttribute('content', 'Impressum | Fiudia');
    document.querySelector<HTMLMetaElement>('meta[property="og:description"]')
      ?.setAttribute(
        'content',
        'Impressum und Kontaktangaben der Fiudia Fitness Hub GmbH i. G.',
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
        <p className="privacy-kicker">Fiudia Fitness Hub GmbH i. G.</p>
        <h1>Impressum</h1>

        <section>
          <h2>Angaben gemäß § 5 DDG</h2>
          <address>
            Fiudia Fitness Hub GmbH i. G.<br />
            vertreten durch die Geschäftsführer Stefan Kunz und Harald Weist
          </address>
        </section>

        <section>
          <h2>Anschrift</h2>
          <address>
            Martin-Luther-Straße 120<br />
            10825 Berlin<br />
            Deutschland
          </address>
        </section>

        <section>
          <h2>Kontakt</h2>
          <p>
            E-Mail: <a href="mailto:talk@fiudia.de">talk@fiudia.de</a><br />
            Telefon: <a href="tel:+491729355000">+49 172 935 5000</a>
          </p>
        </section>

        <section>
          <h2>Weitere Angaben</h2>
          <p>
            Handelsregister: Eintragung ausstehend<br />
            Registergericht: Amtsgericht Charlottenburg (Berlin)
          </p>
          <p>
            Umsatzsteuer-Identifikationsnummer gemäß § 27a UStG: Wird nach Erteilung ergänzt
          </p>
        </section>
      </article>

      <footer className="privacy-footer">
        <a href={homeHref}>Zur Fiudia-Landingpage</a>
        <a href={privacyHref}>Datenschutz</a>
      </footer>
    </main>
  );
}

export default ImpressumPage;
