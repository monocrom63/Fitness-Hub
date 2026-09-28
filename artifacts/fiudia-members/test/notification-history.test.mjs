import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { memberNotificationArchiveQueryOptions } from '../src/notification-history.ts';

test('older member notices remain available through cursor pages in order', async () => {
  const notices = Array.from({ length: 55 }, (_, index) => ({
    id: 155 - index,
    courseId: 300 + index,
    title: `Course change ${index}`,
  }));
  const cursors = [];
  const options = memberNotificationArchiveQueryOptions(async params => {
    cursors.push(params?.beforeId);
    return notices.filter(notice => !params?.beforeId || notice.id < params.beforeId).slice(0, 50);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const history = await client.fetchInfiniteQuery({ ...options, pages: 3 });
    assert.deepEqual(cursors, [undefined, 106]);
    assert.deepEqual(history.pages.map(page => page.length), [50, 5]);
    assert.deepEqual(history.pages.flat().map(item => item.id), notices.map(item => item.id));
    assert.equal(options.getNextPageParam(history.pages.at(-1)), undefined);
    assert.equal(history.pages.at(-1).at(-1).courseId, 354,
      'the oldest notice still links to its own course');
  } finally {
    client.clear();
  }
});