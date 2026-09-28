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

test('a late response from the previous Pulse filter never appears in the active view', async () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(finish => { resolve = finish; });
    return { promise, resolve };
  }
  const oldResponse = deferred<PulseMessage[]>();
  const unreadResponse = deferred<PulseMessage[]>();
  const calls: Array<{ unreadOnly?: boolean; search?: string }> = [];
  const loadMessages: typeof listPulse = async params => {
    calls.push({ unreadOnly: params?.unreadOnly, search: params?.search });
    return params?.unreadOnly ? unreadResponse.promise : oldResponse.promise;
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const all = pulseArchiveQueryOptions('all', '', loadMessages);
  const unread = pulseArchiveQueryOptions('unread', '', loadMessages);
  const observer = new InfiniteQueryObserver(client, all);
  const visible: Array<number[]> = [];
  const unsubscribe = observer.subscribe(result => {
    visible.push(result.data?.pages.flat().map(row => row.id) ?? []);
  });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));

  try {
    await flush();
    assert.deepEqual(calls, [{ unreadOnly: undefined, search: undefined }]);
    observer.setOptions(unread);
    await flush();
    assert.deepEqual(calls.at(-1), { unreadOnly: true, search: undefined });
    assert.equal(observer.getCurrentResult().data, undefined);

    oldResponse.resolve([{ id: 100, isRead: true }] as PulseMessage[]);
    await flush();
    assert.equal(observer.getCurrentResult().data, undefined,
      'the obsolete all-messages response cannot replace the unread view');

    unreadResponse.resolve([{ id: 99, isRead: false }] as PulseMessage[]);
    await flush();
    assert.deepEqual(observer.getCurrentResult().data?.pages.flat().map(row => row.id), [99]);
    assert.ok(!visible.some(ids => ids.includes(100)), 'a stale message must never flash in the active view');

    observer.setOptions(all);
    await flush();
    assert.deepEqual(observer.getCurrentResult().data?.pages.flat().map(row => row.id), [100]);
    observer.setOptions(unread);
    assert.deepEqual(observer.getCurrentResult().data?.pages.flat().map(row => row.id), [99]);
  } finally {
    unsubscribe();
    client.clear();
  }
});