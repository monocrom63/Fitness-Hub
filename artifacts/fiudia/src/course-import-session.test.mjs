import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearCourseImportSession, courseImportSessionKey, loadCourseImportSession, saveCourseImportSession } from './course-import-session.ts';

function storage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}

test('course import recovery is stored separately per studio and preserves completed rows', () => {
  const store = storage();
  const session = {
    version: 1,
    studioId: 10,
    fileName: 'schedule.csv',
    parsed: { rows: [{ line: 2, title: 'Yoga' }] },
    duration: '60',
    capacity: '20',
    roomMap: { yoga: 'Yoga' },
    progress: 1,
    createdLines: [2],
    skippedLines: [],
    results: [],
  };

  assert.equal(saveCourseImportSession(session, store), true);
  assert.deepEqual(loadCourseImportSession(10, store), session);
  assert.equal(loadCourseImportSession(20, store), null);
  clearCourseImportSession(10, store);
  assert.equal(loadCourseImportSession(10, store), null);
  assert.equal(courseImportSessionKey(10), 'fiudia:course-import:v1:10');
});

test('malformed course import recovery data is ignored', () => {
  const store = storage();
  store.setItem(courseImportSessionKey(10), '{broken');
  assert.equal(loadCourseImportSession(10, store), null);
});
