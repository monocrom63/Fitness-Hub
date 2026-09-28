import { useState } from 'react';
import {
  getListCourseEditPushHistoryQueryKey,
  useListCourseEditPushHistory,
} from '@workspace/api-client-react';
import type { Course } from '@workspace/api-client-react';
import './CoursePushDeliveries.css';

const PAGE_SIZE = 30;

function berlinDate(value: string) {
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value));
}

export default function CoursePushHistory({
  studioId,
  onSelect,
}: {
  studioId?: number;
  onSelect: (course: Pick<Course, 'id' | 'title'>) => void;
}) {
  const [offset, setOffset] = useState(0);
  const params = { studioId, offset, limit: PAGE_SIZE };
  const query = useListCourseEditPushHistory(params, {
    query: { queryKey: getListCourseEditPushHistoryQueryKey(params), refetchOnMount: 'always' },
  });
  const entries = query.data ?? [];

  return <div className="course-push-history-index" data-testid="course-push-history">
    <p className="course-push-intro">Hier findest du Kursänderungen mit Push-Zustellungen, auch wenn der Kurs bereits begonnen hat. Vergangene Änderungen können eingesehen, aber nicht erneut versendet werden.</p>
    {query.isLoading && <p className="booking-hint" role="status">Push-Verlauf wird geladen …</p>}
    {query.isError && <p className="form-error" role="alert">Der Push-Verlauf konnte nicht geladen werden. <button type="button" className="button button-outline" onClick={() => void query.refetch()}>Erneut laden</button></p>}
    {!query.isLoading && !query.isError && entries.length === 0 && <p className="course-push-empty">{offset === 0 ? 'Für dieses Studio gibt es noch keine Push-Zustellungen nach manuellen Kursänderungen.' : 'Keine weiteren Kursänderungen gefunden.'}</p>}
    {entries.length > 0 && <ul className="course-push-history-list">
      {entries.map(entry => <li key={entry.courseId}>
        <div><strong>{entry.title}</strong><span>{entry.studioName} · Kurs am {berlinDate(entry.startsAt)}</span><small>Zuletzt geändert: {berlinDate(entry.lastChangeAt)}</small></div>
        <button type="button" className="button button-outline" onClick={() => onSelect({ id: entry.courseId, title: entry.title })} data-testid={`button-open-course-push-history-${entry.courseId}`}>Zustellungen ansehen</button>
      </li>)}
    </ul>}
    <div className="course-push-pages">
      {offset > 0 && <button type="button" className="button button-outline" onClick={() => setOffset(current => Math.max(0, current - PAGE_SIZE))}>Zurück</button>}
      {!query.isLoading && !query.isError && entries.length === PAGE_SIZE && <button type="button" className="button button-outline" onClick={() => setOffset(current => current + PAGE_SIZE)}>Weitere anzeigen</button>}
    </div>
  </div>;
}