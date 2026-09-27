import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { getListPulseQueryKey, type listPulse, type PulseMessage } from '@workspace/api-client-react';
import { pulseArchiveQueryOptions } from './PulseArchiveQuery';

test('Pulse archive keeps pages, search and read filters separate when switching views', async () => {
  const rows = Array.from({ length: 32 }, (_, index) => ({
    id: 100 - index,
    title: index % 3 === 0 ? `Needle ${index}` : `Notice ${index}`,
    isRead: index % 4 === 0,
  }));
  const requests: Array<{ beforeId?: number; unreadOnly?: boolean; search?: string }> = [];
  const loadMessages: typeof listPulse = async params => {
    requests.push({ ...params });
    return rows
      .filter(row => !params?.beforeId || row.id < params.beforeId)
      .filter(row => !params?.unreadOnly || !row.isRead)
      .filter(row => !params?.search || row.title.toLowerCase().includes(params.search.toLowerCase()))
      .slice(0, 30) as PulseMessage[];
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const all = pulseArchiveQueryOptions('all', '', loadMessages);
  const unread = pulseArchiveQueryOptions('unread', '', loadMessages);
  const searched = pulseArchiveQueryOptions('all', 'Needle', loadMessages);
  const searchedUnread = pulseArchiveQueryOptions('unread', 'Needle', loadMessages);

  assert.equal(new Set([all, unread, searched, searchedUnread].map(options => JSON.stringify(options.queryKey))).size, 4);
  const allPages = await client.fetchInfiniteQuery({ ...all, pages: 2 });
  assert.deepEqual(allPages.pages.map(page => page.length), [30, 2]);
  assert.deepEqual(requests, [{}, { beforeId: 71 }]);
  assert.equal(new Set(allPages.pages.flat().map(row => row.id)).size, 32);

  const unreadPages = await client.fetchInfiniteQuery(unread);
  assert.equal(unreadPages.pages[0].length, 24);
  assert.deepEqual(requests.at(-1), { unreadOnly: true });
  assert.ok(unreadPages.pages.flat().every(row => !row.isRead));

  const searchPages = await client.fetchInfiniteQuery(searched);
  assert.equal(searchPages.pages[0].length, 11);
  assert.deepEqual(requests.at(-1), { search: 'Needle' });
  const unreadSearchPages = await client.fetchInfiniteQuery(searchedUnread);
  assert.deepEqual(requests.at(-1), { unreadOnly: true, search: 'Needle' });
  assert.ok(unreadSearchPages.pages[0].every(row => row.title.includes('Needle') && !row.isRead));

  // Switching the live archive to a cached view must never show the old view's pages.
  const observer = new InfiniteQueryObserver(client, unread);
  const unsubscribe = observer.subscribe(() => {});
  try {
    assert.equal(observer.getCurrentResult().data?.pages[0].length, 24);
    observer.setOptions(all);
    assert.deepEqual(observer.getCurrentResult().data?.pages.map(page => page.length), [30, 2]);
    observer.setOptions(searchedUnread);
    assert.deepEqual(observer.getCurrentResult().data?.pages[0].map(row => row.id), unreadSearchPages.pages[0].map(row => row.id));
    observer.setOptions(searched);
    assert.equal(observer.getCurrentResult().data?.pages[0].length, 11);
    observer.setOptions(all);
    assert.deepEqual(observer.getCurrentResult().data?.pages.map(page => page.length), [30, 2]);

    await client.invalidateQueries({ queryKey: getListPulseQueryKey(), refetchType: 'none' });
    assert.ok([all, unread, searched, searchedUnread].every(options =>
      client.getQueryState(options.queryKey)?.isInvalidated));
  } finally {
    unsubscribe();
    client.clear();
  }
});