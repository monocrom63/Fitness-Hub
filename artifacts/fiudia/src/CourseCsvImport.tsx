import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetDashboardQueryKey,
  getListCoursesQueryKey,
  getListStudioRoomsQueryKey,
  useCreateCourse,
  useListStudioRooms,
} from '@workspace/api-client-react';
import type { Me, RoomAsset, StudioSummary } from '@workspace/api-client-react';
import { Upload } from 'lucide-react';
import { berlinDateTimeIso } from './course-time';
import './CourseCsvImport.css';

type CourseRow = {
  line: number;
  title: string;
  instructor: string;
  date: string;
  time: string;
  studioName: string;
  weekday: string;
};

type ParsedCsv = { rows: CourseRow[]; error: string | null; invalidRows: string[] };
type ImportResult = { line: number; message: string };

function parseRecords(text: string): string[][] {
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const delimiters = [';', ',', '\t'];
  let delimiter = ';';
  let most = -1;
  for (const candidate of delimiters) {
    let count = 0;
    let quoted = false;
    for (const char of firstLine) {
      if (char === '"') quoted = !quoted;
      else if (char === candidate && !quoted) count++;
    }
    if (count > most) { delimiter = candidate; most = count; }
  }

  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell.trim()); cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim()); cell = '';
      if (row.some(value => value !== '')) records.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some(value => value !== '')) records.push(row);
  return records;
}

function keyOf(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function columnIndex(headers: string[], aliases: string[]): number {
  return headers.findIndex(header => aliases.includes(keyOf(header)));
}

function parseDate(value: string): string | null {
  const match = value.trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (match) {
    const [, day, month, year] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day)) {
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    return null;
  }
  const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!iso) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function parseCsv(text: string): ParsedCsv {
  const records = parseRecords(text);
  if (records.length < 2) return { rows: [], error: 'Die CSV braucht eine Kopfzeile und mindestens eine Kurszeile.', invalidRows: [] };
  const headers = records[0].map((value, index) => index === 0 ? value.replace(/^\uFEFF/, '') : value);
  const columns = {
    date: columnIndex(headers, ['datum', 'date']),
    time: columnIndex(headers, ['uhrzeit', 'startzeit', 'beginn', 'time', 'start']),
    title: columnIndex(headers, ['kategorie', 'kurs', 'kursart', 'kursname', 'title', 'category']),
    instructor: columnIndex(headers, ['coach', 'trainer', 'trainerin', 'trainerperson', 'instructor']),
    studio: columnIndex(headers, ['studioname', 'studio', 'studio_name', 'standort']),
    weekday: columnIndex(headers, ['wochentag', 'weekday', 'day']),
  };
  const missing = Object.entries({ Datum: columns.date, Uhrzeit: columns.time, Kategorie: columns.title, Coach: columns.instructor, Studio: columns.studio })
    .filter(([, index]) => index < 0).map(([name]) => name);
  if (missing.length) return { rows: [], error: `Diese Spalten fehlen: ${missing.join(', ')}.`, invalidRows: [] };

  const rows: CourseRow[] = [];
  const invalidRows: string[] = [];
  for (let i = 1; i < records.length; i++) {
    const cells = records[i];
    const value = (index: number) => (cells[index] ?? '').trim();
    const date = parseDate(value(columns.date));
    const time = value(columns.time);
    const title = value(columns.title);
    const instructor = value(columns.instructor);
    const studioName = value(columns.studio);
    if (!date || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || title.length < 2 || title.length > 120 ||
        instructor.length < 2 || instructor.length > 120 || !studioName || studioName.length > 120) {
      invalidRows.push(`Zeile ${i + 1}: Datum, Uhrzeit, Kurs, Coach oder Studio ist ungültig.`);
      continue;
    }
    rows.push({ line: i + 1, title, instructor, date, time, studioName, weekday: columns.weekday >= 0 ? value(columns.weekday) : '' });
  }
  if (!rows.length) return { rows: [], error: 'Keine gültigen Kurszeilen gefunden. Prüfe Datum, Uhrzeit, Kurs, Coach und Studio.', invalidRows };
  return { rows, error: null, invalidRows };
}

function RoomMapping({ studioId, value, disabled, onChange }: {
  studioId: number; value: string; disabled: boolean; onChange: (room: string) => void;
}) {
  const rooms = useListStudioRooms(studioId, {
    query: { enabled: studioId > 0, queryKey: getListStudioRoomsQueryKey(studioId), refetchOnMount: 'always' },
  });
  return <label className="field">
    <span>Raum</span>
    <select required value={value} disabled={disabled || rooms.isLoading || rooms.isError || !rooms.data?.length} onChange={event => onChange(event.target.value)}>
      <option value="">{rooms.isLoading ? 'Räume werden geladen …' : rooms.isError ? 'Räume konnten nicht geladen werden' : rooms.data?.length ? 'Raum auswählen' : 'Noch kein Raum angelegt'}</option>
      {rooms.data?.map((room: RoomAsset) => <option key={room.id} value={room.name}>{room.name}</option>)}
    </select>
    {rooms.isError && <button type="button" className="button button-outline" onClick={() => void rooms.refetch()}>Räume erneut laden</button>}
  </label>;
}

export default function CourseCsvImport({ me, studios, studiosLoading, studiosError, onClose, onImported }: {
  me: Me;
  studios: StudioSummary[];
  studiosLoading: boolean;
  studiosError: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const client = useQueryClient();
  const create = useCreateCourse();
  const availableStudios = useMemo<StudioSummary[]>(() => me.role === 'district_manager'
    ? studios
    : me.studioId && me.studioName ? [{ id: me.studioId, name: me.studioName, city: '' }] : [], [me.role, me.studioId, me.studioName, studios]);
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedCsv>({ rows: [], error: '', invalidRows: [] });
  const [duration, setDuration] = useState('60');
  const [capacity, setCapacity] = useState('20');
  const [studioMap, setStudioMap] = useState<Record<string, string>>({});
  const [roomMap, setRoomMap] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<ImportResult[]>([]);

  const sourceStudios = [...new Set(parsed.rows.map(row => row.studioName))];
  const studioFor = (name: string) => availableStudios.find(studio => studio.id === Number(studioMap[name]));
  const mappingComplete = sourceStudios.length > 0 && sourceStudios.every(name => !!studioFor(name));
  const roomsComplete = sourceStudios.length > 0 && sourceStudios.every(name => !!studioFor(name) && !!roomMap[name]);
  const durationValue = Number(duration);
  const capacityValue = Number(capacity);
  const ready = !!parsed.rows.length && !parsed.error && !parsed.invalidRows.length && mappingComplete && roomsComplete &&
    Number.isInteger(durationValue) && durationValue > 0 && durationValue <= 480 &&
    Number.isInteger(capacityValue) && capacityValue >= 1 && capacityValue <= 200 &&
    !studiosLoading && !studiosError;

  async function chooseFile(file?: File) {
    setFileName(file?.name ?? '');
    setResults([]);
    setProgress(0);
    setStudioMap({});
    setRoomMap({});
    if (!file) { setParsed({ rows: [], error: '', invalidRows: [] }); return; }
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setParsed({ rows: [], error: 'Bitte wähle eine CSV-Datei aus.', invalidRows: [] }); return;
    }
    try {
      const result = parseCsv(await file.text());
      setParsed(result);
      if (result.rows.length) {
        const unique = [...new Set(result.rows.map(row => row.studioName))];
        const initial: Record<string, string> = {};
        for (const source of unique) {
          const match = availableStudios.find(studio => keyOf(studio.name) === keyOf(source));
          if (match) initial[source] = String(match.id);
        }
        setStudioMap(initial);
      }
    } catch {
      setParsed({ rows: [], error: 'Die CSV-Datei konnte nicht gelesen werden.', invalidRows: [] });
    }
  }

  function setStudio(source: string, studioId: string) {
    setStudioMap(current => ({ ...current, [source]: studioId }));
    setRoomMap(current => ({ ...current, [source]: '' }));
  }

  function courseDateTime(row: CourseRow, minutesAfterStart: number): string | null {
    const [year, month, day] = row.date.split('-').map(Number);
    const [hour, minute] = row.time.split(':').map(Number);
    const end = new Date(Date.UTC(year, month - 1, day, hour, minute + minutesAfterStart));
    const localValue = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}-${String(end.getUTCDate()).padStart(2, '0')}T${String(end.getUTCHours()).padStart(2, '0')}:${String(end.getUTCMinutes()).padStart(2, '0')}`;
    return berlinDateTimeIso(localValue);
  }

  async function runImport() {
    if (!ready || busy) return;
    setBusy(true);
    setResults([]);
    setProgress(0);
    const failures: ImportResult[] = [];
    let successes = 0;
    for (let index = 0; index < parsed.rows.length; index++) {
      const row = parsed.rows[index];
      const studioId = Number(studioMap[row.studioName]);
      const startsAt = berlinDateTimeIso(`${row.date}T${row.time}`);
      const endsAt = courseDateTime(row, durationValue);
      if (!startsAt || !endsAt) {
        failures.push({ line: row.line, message: 'Berliner Zeit ist wegen einer Zeitumstellung nicht eindeutig oder existiert nicht.' });
      } else {
        try {
          await create.mutateAsync({
            data: {
              title: row.title,
              instructor: row.instructor,
              studioId,
              startsAt,
              endsAt,
              capacity: capacityValue,
              room: roomMap[row.studioName],
            },
          });
          successes++;
        } catch (error) {
          const body = error && typeof error === 'object' ? (error as { data?: { error?: string }; message?: string }) : {};
          failures.push({ line: row.line, message: body.data?.error || body.message || 'Kurs konnte nicht angelegt werden.' });
        }
      }
      setProgress(index + 1);
      if (index % 8 === 7 || index === parsed.rows.length - 1) {
        setResults([...failures]);
        await new Promise(resolve => window.setTimeout(resolve, 0));
      }
    }
    if (successes) onImported();
    setResults(failures);
    setBusy(false);
  }

  const close = () => { if (!busy) onClose(); };
  return <div className="course-csv-import">
    <p className="booking-hint">Eine Zeile wird als ein datierter Kurstermin angelegt. Studio, Trainer und Startzeit kommen aus der CSV; Dauer, Teilnehmerzahl und Raum legst du hier fest.</p>
    <p className="course-csv-notice">Bei aktiviertem Pulse-Modul veröffentlicht Fiudia für jeden angelegten Kurs zusätzlich den Hinweis „Neuer Kurs geplant“.</p>
    <label className="course-csv-upload">
      <Upload size={18} />
      <span>{fileName || 'CSV-Datei auswählen'}</span>
      <input type="file" accept=".csv,text/csv" onChange={event => void chooseFile(event.target.files?.[0])} disabled={busy} />
    </label>
    {parsed.error && <p className="form-error" role="alert">{parsed.error}</p>}
    {!!parsed.invalidRows.length && <div className="course-csv-errors" role="alert"><strong>{parsed.invalidRows.length} ungültige CSV-Zeilen – bitte vor dem Import korrigieren</strong><ul>{parsed.invalidRows.slice(0, 20).map(message => <li key={message}>{message}</li>)}</ul>{parsed.invalidRows.length > 20 && <p>Weitere Fehler werden nach Zeile 20 nicht angezeigt.</p>}</div>}
    {!!parsed.rows.length && <>
      <div className="course-csv-settings">
        <label className="field"><span>Kursdauer (Minuten)</span><input type="number" min="1" max="480" step="1" value={duration} onChange={event => setDuration(event.target.value)} disabled={busy} /></label>
        <label className="field"><span>Teilnehmerzahl</span><input type="number" min="1" max="200" step="1" value={capacity} onChange={event => setCapacity(event.target.value)} disabled={busy} /></label>
      </div>
      <div className="course-csv-studios">
        <h3>Studio und Raum zuordnen</h3>
        {sourceStudios.map(source => {
          const selected = studioFor(source);
          return <div className="course-csv-studio-row" key={source}>
            <label className="field"><span>CSV-Studio: {source}</span>
              <select value={studioMap[source] ?? ''} onChange={event => setStudio(source, event.target.value)} disabled={busy || studiosLoading || studiosError}>
                <option value="">Zielstudio auswählen</option>
                {availableStudios.map(studio => <option key={studio.id} value={studio.id}>{studio.name}{studio.city ? ` · ${studio.city}` : ''}</option>)}
              </select>
            </label>
            {selected && <RoomMapping studioId={selected.id} value={roomMap[source] ?? ''} disabled={busy} onChange={room => setRoomMap(current => ({ ...current, [source]: room }))} />}
          </div>;
        })}
        {studiosLoading && <p className="booking-hint" role="status">Studios werden geladen …</p>}
        {studiosError && <p className="form-error" role="alert">Studios konnten nicht geladen werden. Bitte schließe den Importdialog und versuche es erneut.</p>}
      </div>
      <div className="course-csv-preview">
        <strong>{parsed.rows.length} Termine erkannt</strong>
        <span>{parsed.rows[0].date} bis {parsed.rows[parsed.rows.length - 1].date} · {sourceStudios.length} Studios</span>
        <ul>{parsed.rows.slice(0, 5).map(row => <li key={row.line}>{row.date} {row.time} · {row.title} · {row.instructor} · {row.studioName}</li>)}</ul>
        {parsed.rows.length > 5 && <span>und {parsed.rows.length - 5} weitere Termine</span>}
      </div>
    </>}
    {busy && <div className="course-csv-progress" role="status">Import läuft: {progress} von {parsed.rows.length} geprüft …</div>}
    {!busy && progress > 0 && <p className="course-csv-progress" role="status">{progress - results.length} Kurse angelegt, {results.length} fehlgeschlagen.</p>}
    {!!results.length && <div className="course-csv-errors" role="alert"><strong>Fehlgeschlagene Zeilen</strong><ul>{results.map(result => <li key={`${result.line}-${result.message}`}>Zeile {result.line}: {result.message}</li>)}</ul></div>}
    {!!progress && !busy && !results.length && <p className="course-csv-success" role="status">Alle {progress} Kurse wurden angelegt.</p>}
    <div className="course-csv-actions">
      <button type="button" className="button button-outline" onClick={close} disabled={busy}>{progress && !busy ? 'Schließen' : 'Abbrechen'}</button>
      {!progress && <button type="button" className="button button-dark" onClick={() => void runImport()} disabled={!ready || busy}>
        {busy ? 'Import läuft …' : `${parsed.rows.length ? `${parsed.rows.length} Kurse anlegen` : 'Import starten'}`}
      </button>}
    </div>
  </div>;
}
