import { useListPulseHistory } from '@workspace/api-client-react';

const fieldNames = { title: 'Titel', body: 'Nachrichtentext', priority: 'Priorität' };
const priorities: Record<string, string> = { info: 'Info', important: 'Wichtig', urgent: 'Dringend' };

function dateTime(value: string) {
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

export function PulseHistory({ messageId }: { messageId: number }) {
  const history = useListPulseHistory(messageId);

  return <section className="pulse-history" aria-label="Korrekturverlauf" data-testid={`pulse-history-${messageId}`}>
    <h3>Korrekturverlauf</h3>
    {history.isLoading ? <p role="status">Korrekturen werden geladen …</p>
      : history.isError ? <p role="alert">Der Korrekturverlauf konnte nicht geladen werden. <button type="button" onClick={() => history.refetch()}>Erneut versuchen</button></p>
      : !history.data?.length ? <p>Für frühere Korrekturen liegen keine Details vor.</p>
      : <ol>{history.data.map(entry => <li key={entry.id}>
        <strong>{entry.editorName} · {dateTime(entry.editedAt)}</strong>
        <ul>{entry.changes.map(change => <li key={change.field}>
          <span>{fieldNames[change.field]}</span>
          <div className="pulse-history-diff">
            <div><small>Vorher</small><p>{change.field === 'priority' ? priorities[change.before] ?? change.before : change.before}</p></div>
            <div><small>Nachher</small><p>{change.field === 'priority' ? priorities[change.after] ?? change.after : change.after}</p></div>
          </div>
        </li>)}</ul>
      </li>)}</ol>}
  </section>;
}