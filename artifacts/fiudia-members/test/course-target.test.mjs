import assert from 'node:assert/strict';
import { test } from 'node:test';
import { courseDisplayState, courseFilterHref, readCourseLocation } from '../src/course-target.ts';

const courses = [
  { id: 42, startsAt: '2026-10-02T10:00:00Z', bookingStatus: null },
  { id: 41, startsAt: '2026-09-01T10:00:00Z', bookingStatus: 'confirmed' },
  { id: 43, startsAt: '2026-10-03T10:00:00Z', bookingStatus: 'waitlisted' },
];

test('a course linked from a notice stays selected across filters and reloads', () => {
  const initial = '?courseId=41';
  const first = readCourseLocation(initial);
  assert.deepEqual(first, { targetId: 41, filter: 'all' });
  assert.deepEqual(courseDisplayState(courses, first.filter, first.targetId).visible.map(course => course.id), [41, 42, 43]);

  const switched = courseFilterHref(initial, 'mine');
  assert.equal(switched, '/courses?courseId=41&filter=mine');
  const reloaded = readCourseLocation(new URL(switched, 'https://example.invalid').search);
  assert.deepEqual(reloaded, { targetId: 41, filter: 'mine' });
  assert.deepEqual(courseDisplayState(courses, reloaded.filter, reloaded.targetId), {
    visible: [courses[1], courses[2]], targetExists: true, targetVisible: true,
  });
  assert.equal(courseFilterHref(new URL(switched, 'https://example.invalid').search, 'all'), '/courses?courseId=41');
});

test('filtered and unavailable targets do not point at a different course', () => {
  const location = readCourseLocation('?filter=mine&courseId=42');
  const filtered = courseDisplayState(courses, location.filter, location.targetId);
  assert.deepEqual(filtered.visible.map(course => course.id), [41, 43]);
  assert.equal(filtered.targetExists, true);
  assert.equal(filtered.targetVisible, false);
  const unfiltered = courseFilterHref('?filter=mine&courseId=42', 'all');
  assert.equal(unfiltered, '/courses?courseId=42');
  const afterReload = readCourseLocation(new URL(unfiltered, 'https://example.invalid').search);
  assert.equal(courseDisplayState(courses, afterReload.filter, afterReload.targetId).targetVisible, true);
  assert.equal(courseDisplayState(courses, 'all', 999).targetExists, false);
  assert.deepEqual(readCourseLocation('?courseId=0&filter=unknown'), { targetId: null, filter: 'all' });
  assert.equal(readCourseLocation('?courseId=999999999999999999999').targetId, null);
});