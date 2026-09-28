import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetCourseEditPushDeliveriesQueryKey,
  useGetCourseEditPushDeliveries,
  useRetryCourseEditPushDelivery,
} from '@workspace/api-client-react';
import type { Course } from '@workspace/api-client-react';
import './CoursePushDeliveries.css';

const statusLabels = {
  pending: 'Ausstehend',
  sending: 'Wird gesendet',
  sent: 'Gesendet',
  failed: 'Fehlgeschlagen',
  skipped: 'Übersprungen',
};

function displayError(error: unknown): string {
  return (error as { data?: { error?: string } } | null)?.data?.error || 'Die Anfrage ist fehlgeschlagen. Bitte versuche es erneut.';
}

function berlinDate(value: string) {
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value));
}

export default function CoursePushDeliveries({ course }: { course: Pick<Course, 'id' | 'title'> }) {
  const client = useQueryClient();
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [retryError, setRetryError] = useState('');
  const [retryMessage, setRetryMessage] = useState('');
  const queryKey = getGetCourseEditPushDeliveriesQueryKey(course.id);
  const query = useGetCourseEditPushDeliveries(course.id, {
    query: {
      queryKey,
      refetchOnMount: 'always',
      refetchInterval: current => current.state.data?.deliveries.some(item =>
        item.status === 'pending' || item.status === 'sending'
      ) ? 5000 : 15000,
    },
  });
  const retry = useRetryCourseEditPushDelivery();
  const deliveries = query.data?.deliveries ?? [];
  const revisions = [...new Set(deliveries.map(item => item.revision))].sort((a, b) => b - a);

  function retryDelivery(deliveryId: number) {
    setRetryError('');
    setRetryMessage('');
    setRetryingId(deliveryId);
    retry.mutate({ id: course.id, deliveryId }, {
      onSuccess: report => {
        client.setQueryData(queryKey, report);
        setRetryMessage('Ein erneuter Zustellversuch ist vorgemerkt. Der Status wird hier aktualisiert.');
        setRetryingId(null);
      },
      onError: error => {
        setRetryError(displayError(error));
        setRetryingId(null);
        void client.invalidateQueries({ queryKey });
      },
    });
  }

  return <div className="course-push-report" data-testid={`course-push-report-${course.id}`}>
    <p className="course-push-intro">Push-Status pro Browser-Gerät. „Gesendet“ bedeutet, dass der Push-Dienst die Nachricht angenommen hat, nicht dass sie auf dem Gerät angezeigt wurde. In-App-Hinweise bleiben unabhängig von Push sichtbar.</p>
    {query.isLoading && <p className="booking-hint" role="status">Zustellungen werden geladen …</p>}
    {query.isError && <p className="form-error" role="alert">Zustellungen konnten nicht geladen werden. {displayError(query.error)} <button className="button button-outline" type="button" onClick={() => void query.refetch()}>Erneut laden</button></p>}
    {!query.isLoading && !query.isError && revisions.length === 0 && <div className="course-push-empty">Für diesen Kurs sind noch keine Push-Zustellungen nach einer manuellen Änderung vorhanden. Ohne angemeldete Browser-Geräte werden nur In-App-Hinweise erstellt.</div>}
    {revisions.length > 0 && <div className="course-push-history">
      {revisions.map(revision => {
        const rows = deliveries.filter(item => item.revision === revision);
        const counts = rows.reduce((total, item) => {
          total[item.status] += 1;
          return total;
        }, { sent: 0, failed: 0, pending: 0, sending: 0, skipped: 0 });
        return <section className="course-push-revision" key={revision} aria-label={`Kursänderung ${revision}`}>
          <div className="course-push-heading"><div><strong>Änderung vom {berlinDate(rows[0].createdAt)}</strong><span>{revision === query.data?.currentRevision ? 'Aktuelle Kursfassung' : 'Frühere Kursfassung · kein erneuter Versand'}</span></div></div>
          <div className="course-push-counts" aria-label="Zustellzahlen">
            <span className="sent">{counts.sent} gesendet</span>
            <span className="failed">{counts.failed} fehlgeschlagen</span>
            <span>{counts.pending + counts.sending} ausstehend</span>
            <span>{counts.skipped} übersprungen</span>
          </div>
          <ul className="course-push-list">
            {rows.map(item => <li key={item.id} data-testid={`course-push-delivery-${item.id}`}>
              <div className="course-push-recipient"><strong>{item.memberName}</strong><span>Browser-Gerät · {item.attemptCount} {item.attemptCount === 1 ? 'Versuch' : 'Versuche'}</span></div>
              <div className="course-push-outcome">
                <span className={`course-push-state ${item.status}`}>{statusLabels[item.status]}</span>
                {item.error && <small>{item.error}</small>}
                {item.canRetry && <button type="button" className="button button-outline" disabled={retry.isPending} onClick={() => retryDelivery(item.id)} data-testid={`button-retry-course-push-${item.id}`}>{retryingId === item.id ? 'Wird vorgemerkt …' : 'Erneut versuchen'}</button>}
              </div>
            </li>)}
          </ul>
        </section>;
      })}
    </div>}
    {retryMessage && <p className="course-push-feedback" role="status">{retryMessage}</p>}
    {retryError && <p className="form-error" role="alert">{retryError}</p>}
  </div>;
}