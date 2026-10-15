import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findDuplicateCourseLines } from './course-import-dedup.ts';

test('course CSV duplicate detection skips already scheduled matches and repeated rows', () => {
  const rows = [
    { line: 2, title: 'Yoga Flow', instructor: 'Éva Müller', startsAt: '2026-11-02T17:00:00.000Z' },
    { line: 3, title: ' HIIT  ', instructor: 'Sam Trainer', startsAt: '2026-11-03T17:00:00.000Z' },
    { line: 4, title: 'HIIT', instructor: 'Sam Trainer', startsAt: '2026-11-03T17:00:00Z' },
    { line: 5, title: 'Pilates', instructor: 'Sam Trainer', startsAt: '2026-11-03T17:00:00Z' },
  ];
  const existing = [
    { title: 'Yoga Flow', instructor: 'Eva Muller', startsAt: '2026-11-02T17:00:00Z' },
  ];

  assert.deepEqual([...findDuplicateCourseLines(rows, existing)], [2, 4]);
});
