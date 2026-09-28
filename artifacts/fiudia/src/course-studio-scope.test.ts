import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { StudioSummary } from '@workspace/api-client-react';
import {
  chooseAccessibleStudio, courseQueryScope, persistStudioId, readStoredStudioId, studioScopeStorageKey,
} from './course-studio-scope';

test('studio choice survives reload, stays account-specific and rejects stale or foreign IDs', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const firstKey = studioScopeStorageKey('manager-one');
  const secondKey = studioScopeStorageKey('manager-two');
  const available = [
    { id: 10, name: 'Nord', city: 'Berlin' },
    { id: 20, name: 'Süd', city: 'Berlin' },
  ] as StudioSummary[];

  persistStudioId(firstKey, 20, () => storage);
  assert.equal(readStoredStudioId(firstKey, () => storage), 20);
  assert.equal(chooseAccessibleStudio(available, readStoredStudioId(firstKey, () => storage), 10)?.id, 20);
  assert.equal(readStoredStudioId(secondKey, () => storage), null);
  assert.equal(chooseAccessibleStudio(available, readStoredStudioId(secondKey, () => storage), 10)?.id, 10);

  values.set(firstKey, '999');
  assert.equal(chooseAccessibleStudio(available, readStoredStudioId(firstKey, () => storage), 10)?.id, 10,
    'a deleted or foreign stored studio falls back to an accessible studio');
  assert.equal(chooseAccessibleStudio(available, 999, null)?.id, 10);
  assert.equal(chooseAccessibleStudio([], 20, 10), undefined);
  for (const invalid of ['0', '-1', '1.5', 'NaN', 'Infinity', '']) {
    values.set(firstKey, invalid);
    assert.equal(readStoredStudioId(firstKey, () => storage), null);
  }
  persistStudioId(firstKey, null, () => storage);
  assert.equal(values.has(firstKey), false);

  const unavailableStorage = { getItem: () => { throw new Error('blocked'); } };
  assert.equal(readStoredStudioId(firstKey, () => unavailableStorage), null);
  assert.equal(readStoredStudioId(firstKey, () => { throw new Error('storage access denied'); }), null);
  assert.doesNotThrow(() => persistStudioId(firstKey, 10, () => { throw new Error('storage access denied'); }));
});

test('course results stay attached to the selected studio across fast switches', async () => {
  const missing = courseQueryScope(true, null);
  const north = courseQueryScope(true, 10);
  const south = courseQueryScope(true, 20);
  assert.equal(missing.query.enabled, false, 'never fetch an unfiltered district course list while studios load');
  assert.equal(north.params?.studioId, 10);
  assert.equal(south.params?.studioId, 20);
  assert.notDeepEqual(north.query.queryKey, south.query.queryKey);
  assert.equal(courseQueryScope(false, null).query.enabled, true);

  type Row = { studioId: number; title: string };
  let resolveNorth!: (rows: Row[]) => void;
  let resolveSouth!: (rows: Row[]) => void;
  const northResponse = new Promise<Row[]>(resolve => { resolveNorth = resolve; });
  const southResponse = new Promise<Row[]>(resolve => { resolveSouth = resolve; });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const observer = new QueryObserver(client, { ...north.query, queryFn: () => northResponse });
  const visible: Array<Row[] | undefined> = [];
  const unsubscribe = observer.subscribe(result => { visible.push(result.data); });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    await flush();
    observer.setOptions({ ...south.query, queryFn: () => southResponse });
    assert.equal(observer.getCurrentResult().data, undefined);
    resolveSouth([{ studioId: 20, title: 'Kurs Süd' }]);
    await flush();
    assert.equal(observer.getCurrentResult().data?.[0].studioId, 20);
    resolveNorth([{ studioId: 10, title: 'Kurs Nord' }]);
    await flush();
    assert.equal(observer.getCurrentResult().data?.[0].studioId, 20);
    assert.ok(visible.every(rows => !rows || rows.every(row => row.studioId === 20)));
    observer.setOptions({ ...north.query, queryFn: () => northResponse });
    assert.equal(observer.getCurrentResult().data?.[0].studioId, 10);
  } finally {
    unsubscribe();
    client.clear();
  }
});