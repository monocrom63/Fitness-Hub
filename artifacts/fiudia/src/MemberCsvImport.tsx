import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetDashboardQueryKey, getListMembersQueryKey, useCreateMember } from '@workspace/api-client-react';
import type { Me, Member } from '@workspace/api-client-react';
import { Upload } from 'lucide-react';
import './MemberCsvImport.css';

type CustomerRow = {
  line: number; fullName: string; email: string; phone: string; membershipType: string;
  birthDate: string | null; address: string | null; contractStart: string | null; contractDurationMonths: number | null;
  status: 'active' | 'trial' | 'paused';
};
type ParseResult = { rows: CustomerRow[]; error: string; invalid: string[] };

function recordsFromCsv(text: string): string[][] {
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const delimiters = [';', ',', '\t'];
  let delimiter = ';'; let max = -1;
  for (const candidate of delimiters) {
    const count = [...first].filter(char => char === candidate).length;
    if (count > max) { delimiter = candidate; max = count; }
  }
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (char === delimiter && !quoted) { row.push(cell.trim()); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim()); cell = '';
      if (row.some(value => value)) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some(value => value)) rows.push(row);
  return rows;
}

function normalize(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function dateValue(value: string): string | null {
  const match = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!match) return null;
  const [, d, m, y] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d)
    ? `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}` : null;
}

function parseCsv(text: string): ParseResult {
  const table = recordsFromCsv(text);
  if (table.length < 2) return { rows: [], error: 'Die CSV braucht eine Kopfzeile und mindestens eine Kundenzeile.', invalid: [] };
  const headers = table[0].map(normalize);
  const find = (...names: string[]) => headers.findIndex(header => names.includes(header));
  const columns = {
    surname: find('name', 'nachname', 'surname', 'lastname'),
    given: find('vorname', 'givenname', 'firstname'),
    fullName: find('vollername', 'vollstandigername', 'fullname'),
    email: find('email', 'emailadresse', 'mail'),
    phone: find('telefon', 'telefonnummer', 'telnummer', 'phone', 'mobile'),
    category: find('kategorie', 'mitgliedschaft', 'mitgliedschaftsart', 'membershiptype', 'category'),
    birthDate: find('geburtsdatum', 'birthdate', 'dateofbirth'),
    address: find('adresse', 'anschrift', 'address'),
    contractStart: find('vertragsbeginn', 'vertragbeginn', 'contractstart'),
    contractDuration: find('vertragsdauer', 'contractduration'),
    status: find('status', 'mitgliedsstatus'),
  };
  const missing = [
    ...(columns.email < 0 ? ['E-Mail'] : []),
    ...(columns.category < 0 ? ['Kategorie/Mitgliedschaft'] : []),
    ...(columns.fullName < 0 && (columns.surname < 0 || columns.given < 0) ? ['Vorname und Name'] : []),
  ];
  if (missing.length) return { rows: [], error: `Diese Pflichtspalten fehlen: ${missing.join(', ')}.`, invalid: [] };

  const rows: CustomerRow[] = []; const invalid: string[] = [];
  for (let i = 1; i < table.length; i++) {
    const row = table[i]; const value = (index: number) => index < 0 ? '' : (row[index] ?? '').trim();
    const fullName = columns.fullName >= 0 ? value(columns.fullName) : `${value(columns.given)} ${value(columns.surname)}`.trim();
    const email = value(columns.email).toLowerCase();
    const membershipType = value(columns.category);
    const birthRaw = value(columns.birthDate); const startRaw = value(columns.contractStart);
    const birthDate = birthRaw ? dateValue(birthRaw) : null;
    const contractStart = startRaw ? dateValue(startRaw) : null;
    const durationRaw = value(columns.contractDuration);
    const durationMatch = durationRaw.match(/(\d+)/);
    const contractDurationMonths = durationMatch ? Number(durationMatch[1]) : null;
    if (fullName.length < 2 || fullName.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320 ||
        membershipType.length < 2 || membershipType.length > 80 || value(columns.phone).length > 40 ||
        value(columns.address).length > 400 || (birthRaw && !birthDate) || (startRaw && !contractStart) ||
        (durationRaw && (!contractDurationMonths || contractDurationMonths > 1200))) {
      invalid.push(`Zeile ${i + 1}: Name, E-Mail, Mitgliedschaft oder optionale Vertrags-/Adressdaten ungültig.`);
      continue;
    }
    const statusRaw = normalize(value(columns.status));
    const status = !statusRaw || statusRaw === 'active' || statusRaw === 'aktiv' ? 'active'
      : statusRaw === 'paused' || statusRaw === 'pausiert' ? 'paused'
      : statusRaw === 'trial' || statusRaw === 'probetraining' ? 'trial' : null;
    if (!status) {
      invalid.push(`Zeile ${i + 1}: Status muss Aktiv, Probetraining oder Pausiert sein.`);
      continue;
    }
    rows.push({
      line: i + 1, fullName, email, phone: value(columns.phone), membershipType,
      birthDate, address: value(columns.address) || null, contractStart, contractDurationMonths, status,
    });
  }
  return { rows, error: rows.length ? '' : 'Keine gültigen Kundenzeilen gefunden.', invalid };
}

export default function MemberCsvImport({ me, existingMembers, loadingMembers, onClose, onImported }: {
  me: Me; existingMembers: Member[]; loadingMembers: boolean; onClose: () => void; onImported: () => void;
}) {
  const client = useQueryClient();
  const create = useCreateMember();
  const [filename, setFilename] = useState('');
  const [parsed, setParsed] = useState<ParseResult>({ rows: [], error: '', invalid: [] });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [created, setCreated] = useState(0);
  const [failures, setFailures] = useState<{ line: number; reason: string }[]>([]);
  const duplicateEmails = new Set<string>();
  const seen = new Set<string>();
  for (const row of parsed.rows) {
    if (seen.has(row.email) || existingMembers.some(member => member.email?.toLowerCase() === row.email)) duplicateEmails.add(row.email);
    seen.add(row.email);
  }
  const ready = !!parsed.rows.length && !parsed.error && !parsed.invalid.length && !loadingMembers;
  async function selectFile(file?: File) {
    setFilename(file?.name ?? ''); setFailures([]); setProgress(0); setCreated(0);
    if (!file) { setParsed({ rows: [], error: '', invalid: [] }); return; }
    if (!file.name.toLowerCase().endsWith('.csv')) { setParsed({ rows: [], error: 'Bitte wähle eine CSV-Datei aus.', invalid: [] }); return; }
    try { setParsed(parseCsv(await file.text())); } catch { setParsed({ rows: [], error: 'Die CSV-Datei konnte nicht gelesen werden.', invalid: [] }); }
  }
  async function importRows() {
    if (!ready || busy || !me.studioId) return;
    setBusy(true); setFailures([]); setProgress(0); setCreated(0);
    const errors: { line: number; reason: string }[] = []; let count = 0;
    for (let index = 0; index < parsed.rows.length; index++) {
      const row = parsed.rows[index];
      if (duplicateEmails.has(row.email)) {
        errors.push({ line: row.line, reason: 'E-Mail ist bereits in diesem Import oder Studio vorhanden; keine Verknüpfung durchgeführt.' });
      } else {
        try {
          await create.mutateAsync({ data: {
            fullName: row.fullName, email: row.email, phone: row.phone || undefined,
            membershipType: row.membershipType, status: row.status, studioId: me.studioId,
            birthDate: row.birthDate, address: row.address, contractStart: row.contractStart,
            contractDurationMonths: row.contractDurationMonths,
          } });
          count++;
        } catch (error) {
          const apiError = error as { data?: { error?: string }; message?: string };
          errors.push({ line: row.line, reason: apiError.data?.error || apiError.message || 'Mitglied konnte nicht angelegt werden.' });
        }
      }
      setProgress(index + 1); setCreated(count);
      if (index % 8 === 7 || index === parsed.rows.length - 1) { setFailures([...errors]); await new Promise(resolve => window.setTimeout(resolve, 0)); }
    }
    if (count) {
      onImported();
      void client.invalidateQueries({ queryKey: getListMembersQueryKey() });
      void client.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    }
    setFailures(errors); setBusy(false);
  }
  return <div className="member-csv-import">
    <p className="booking-hint">Die Spalten Vorname + Name werden zusammengeführt. „Kategorie“ wird als Mitgliedschaft übernommen. Nicht enthaltene Statuswerte werden auf „Aktiv“ gesetzt. Alle Mitglieder landen im aktuell ausgewählten Studio; es werden keine Konten verknüpft und keine Einladungen versendet.</p>
    <label className="member-csv-upload"><Upload size={18} /><span>{filename || 'Kunden-CSV auswählen'}</span><input type="file" accept=".csv,text/csv" disabled={busy} onChange={event => void selectFile(event.target.files?.[0])} /></label>
    {parsed.error && <p className="form-error" role="alert">{parsed.error}</p>}
    {!!parsed.invalid.length && <div className="member-csv-errors" role="alert"><strong>{parsed.invalid.length} ungültige Zeilen – bitte CSV korrigieren</strong><ul>{parsed.invalid.slice(0, 20).map(item => <li key={item}>{item}</li>)}</ul></div>}
    {!!parsed.rows.length && <div className="member-csv-preview">
      <strong>{parsed.rows.length} Kundenzeilen erkannt · Studio: {me.studioName || 'ausgewähltes Studio'}</strong>
      <span>{duplicateEmails.size ? `${duplicateEmails.size} E-Mail-Dubletten werden übersprungen.` : 'Keine E-Mail-Dubletten gefunden.'}</span>
      <ul>{parsed.rows.slice(0, 5).map(row => <li key={row.line}>{row.fullName} · {row.email} · {row.membershipType}</li>)}</ul>
      {parsed.rows.length > 5 && <span>und {parsed.rows.length - 5} weitere</span>}
    </div>}
    {busy && <p className="member-csv-progress" role="status">Import läuft: {progress} von {parsed.rows.length} · {created} angelegt …</p>}
    {!busy && progress > 0 && <p className="member-csv-progress" role="status">{created} angelegt, {failures.length} übersprungen oder fehlgeschlagen.</p>}
    {!!failures.length && <div className="member-csv-errors" role="alert"><strong>Übersprungene oder fehlgeschlagene Zeilen</strong><ul>{failures.map(item => <li key={`${item.line}-${item.reason}`}>Zeile {item.line}: {item.reason}</li>)}</ul></div>}
    {!!progress && !busy && !failures.length && <p className="member-csv-success" role="status">Alle {created} Mitglieder wurden angelegt.</p>}
    <div className="member-csv-actions"><button type="button" className="button button-outline" onClick={() => !busy && onClose()} disabled={busy}>{progress && !busy ? 'Schließen' : 'Abbrechen'}</button>{!progress && <button type="button" className="button button-dark" onClick={() => void importRows()} disabled={!ready || busy || !me.studioId}>{busy ? 'Import läuft …' : `${parsed.rows.length} Mitglieder importieren`}</button>}</div>
  </div>;
}
