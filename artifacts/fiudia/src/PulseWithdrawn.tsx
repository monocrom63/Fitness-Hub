import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { getListPulseQueryKey, listPulse } from '@workspace/api-client-react';
import { PulseHistory } from './PulseHistory';

// This manager-only archive is deliberately separate from the ordinary feed.
export function PulseWithdrawn() {
  const [open, setOpen] = useState(false);
  const [historyId, setHistoryId] = useState<number | null>(null);
  const query = useInfiniteQuery({
    queryKey: [...getListPulseQueryKey(), 'withdrawn'],
    queryFn: ({ pageParam, signal }) => listPulse({
      retractedOnly: true,
      ...(pageParam ? { beforeId: pageParam } : {}),
    }, { signal }),
    initialPageParam: 0,
    getNextPageParam: last => last.length === 30 ? last[last.length - 1].id : undefined,
    enabled: open,
    refetchInterval: 60000,
  });
  return <section aria-label="Zurückgezogene Meldungen" className="pulse-history">
    <button type="button" className="button button-outline" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? 'Zurückgezogene Meldungen schließen' : 'Zurückgezogene Meldungen prüfen'}
    </button>
    {open && <>
      <h2>Zurückgezogene Meldungen</h2>
      <p>Nur für Leitungen. Diese Meldungen erscheinen nicht mehr im normalen Feed.</p>
      {query.isLoading ? <p role="status">Meldungen werden geladen …</p>
        : query.isError && !query.data ? <p role="alert">Meldungen konnten nicht geladen werden. <button onClick={() => query.refetch()}>Erneut versuchen</button></p>
        : !query.data?.pages.flat().length ? <p>Keine zurückgezogenen Meldungen vorhanden.</p>
        : query.data.pages.flat().map(message => <article className="pulse-card" key={message.id}>
          <span className="pulse-tag">Zurückgezogen · {message.studioName || 'Gesamte Organisation'}</span>
          <h3>{message.title}</h3>
          <p>{message.body}</p>
          <button type="button" className="pulse-history-toggle" aria-expanded={historyId === message.id} onClick={() => setHistoryId(historyId === message.id ? null : message.id)}>
            {historyId === message.id ? 'Änderungsverlauf schließen' : 'Änderungsverlauf ansehen'}
          </button>
          {historyId === message.id && <PulseHistory messageId={message.id} />}
        </article>)}
      {query.hasNextPage && <button type="button" className="button button-outline" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>{query.isFetchingNextPage ? 'Wird geladen …' : 'Ältere zurückgezogene Meldungen laden'}</button>}
      {query.isError && query.data && <p role="alert">Die Liste konnte nicht aktualisiert werden. <button onClick={() => query.refetch()}>Erneut versuchen</button></p>}
    </>}
  </section>;
}
