import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MemberCourse } from '@workspace/api-client-react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Route, Router } from 'wouter';
import { CoursesPage } from '../src/App';

// Exercise the production page, rows, effects and URL router, not a copy of them.
// Only the data/auth boundary is replaced: no Clerk provider, account or key.
const { listCourses, memberActions } = vi.hoisted(() => ({
  listCourses: vi.fn(),
  memberActions: {
    book: { isPending: false, mutateAsync: vi.fn() },
    cancel: { isPending: false, mutateAsync: vi.fn() },
  },
}));
vi.mock('@/hooks/use-member', () => ({
  useListMemberCourses: listCourses,
  useMemberActions: () => memberActions,
}));
vi.mock('@clerk/shared/keys', () => ({
  publishableKeyFromHost: () => undefined,
}));

const base = '/fiudia-members';
const scrollCalls: Array<{ id: string; options: ScrollIntoViewOptions | undefined }> = [];
let rows: MemberCourse[];
let loading: boolean;

function course(id: number, day: number, bookingStatus: MemberCourse['bookingStatus']): MemberCourse {
  return {
    id, title: 'Yoga', instructor: `Trainer ${id}`, studioName: 'Teststudio',
    startsAt: `2099-10-${day}T10:00:00Z`, endsAt: `2099-10-${day}T11:00:00Z`,
    capacity: 12, enrolled: 5, room: 'Raum A', bookingStatus,
    waitlistPosition: bookingStatus === 'waitlisted' ? 2 : null,
  };
}

function Page() {
  return <Router base={base}><Route path="/courses"><CoursesPage /></Route></Router>;
}

function open(search = '?courseId=42') {
  window.history.replaceState(null, '', `${base}/courses${search}`);
  return render(<Page />);
}

function visibleIds() {
  return [...document.querySelectorAll<HTMLElement>('.course-row')].map(row => row.id);
}

async function expectTarget(id: number) {
  const row = screen.getByTestId(`card-course-${id}`);
  await waitFor(() => {
    expect([...document.querySelectorAll('.course-row--targeted')]).toEqual([row]);
    expect(document.activeElement).toBe(row);
    expect(scrollCalls.at(-1)).toEqual({
      id: `course-${id}`, options: { block: 'center', behavior: 'smooth' },
    });
  });
}

function expectNoTarget() {
  expect(document.querySelector('.course-row--targeted')).toBeNull();
  expect(document.activeElement?.classList.contains('course-row')).toBe(false);
  expect(scrollCalls).toEqual([]);
}

beforeEach(() => {
  // Unsorted, identical titles: identity must be the ID, not title or position.
  rows = [course(43, 23, 'waitlisted'), course(41, 21, 'confirmed'), course(42, 22, 'confirmed')];
  loading = false;
  listCourses.mockImplementation(() => ({
    data: loading ? undefined : rows,
    isLoading: loading, isError: false, refetch: vi.fn(),
  }));
  scrollCalls.length = 0;
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
    this: HTMLElement, options?: boolean | ScrollIntoViewOptions,
  ) {
    scrollCalls.push({ id: this.id, options: typeof options === 'object' ? options : undefined });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

// jsdom has no layout/scroll implementation; record which actual DOM node the
// production effect scrolls, and retain native DOM focus behavior.
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true, writable: true, value() {},
});

test('a notice URL marks, focuses and scrolls only its own course among several courses', async () => {
  open();
  expect(visibleIds()).toEqual(['course-41', 'course-42', 'course-43']);
  expect(listCourses).toHaveBeenLastCalledWith({ courseId: 42 });
  await expectTarget(42);
  expect(scrollCalls.map(call => call.id)).toEqual(['course-42']);
  // preventScroll avoids a second, competing scroll caused by focus().
  const focus = vi.spyOn(HTMLElement.prototype, 'focus');
  await act(async () => {
    window.history.pushState(null, '', `${base}/courses?courseId=43`);
  });
  await expectTarget(43);
  expect(listCourses).toHaveBeenLastCalledWith({ courseId: 43 });
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(scrollCalls.map(call => call.id)).toEqual(['course-42', 'course-43']);
});

test('a fresh mount from the URL restores the target after courses finish loading', async () => {
  const first = open();
  await expectTarget(42);
  const savedUrl = window.location.href;
  first.unmount();
  scrollCalls.length = 0;
  loading = true;
  const reloaded = render(<Page />);
  expectNoTarget();
  expect(screen.queryByTestId('status-course-unavailable')).toBeNull();
  loading = false;
  reloaded.rerender(<Page />);
  await expectTarget(42);
  expect(window.location.href).toBe(savedUrl);
  expect(scrollCalls.map(call => call.id)).toEqual(['course-42']);
});

test.each([
  ['confirmed', 42],
  ['waitlisted', 43],
] as const)('Meine Plätze preserves the %s target through filter changes and URL reload', async (_, id) => {
  const page = open(`?courseId=${id}`);
  await expectTarget(id);
  // Ensure filtering also removes an unrelated unbooked row.
  rows = rows.map(row => row.id === 41 ? { ...row, bookingStatus: null } : row);
  page.rerender(<Page />);
  scrollCalls.length = 0;
  fireEvent.click(screen.getByTestId('button-filter-mine'));
  await expectTarget(id);
  expect(visibleIds()).toEqual(['course-42', 'course-43']);
  expect(window.location.pathname).toBe(`${base}/courses`);
  expect(new URLSearchParams(window.location.search).get('courseId')).toBe(String(id));
  expect(new URLSearchParams(window.location.search).get('filter')).toBe('mine');

  page.unmount();
  scrollCalls.length = 0;
  render(<Page />);
  await expectTarget(id);
  expect(screen.getByTestId('button-filter-mine').classList.contains('selected')).toBe(true);
  fireEvent.click(screen.getByTestId('button-filter-all'));
  await expectTarget(id);
  expect(visibleIds()).toEqual(['course-41', 'course-42', 'course-43']);
  expect(window.location.search).toBe(`?courseId=${id}`);
  expect(scrollCalls.every(call => call.id === `course-${id}`)).toBe(true);
});

test('a no-longer-booked target is not replaced by another booking in Meine Plätze', async () => {
  const page = open();
  await expectTarget(42);
  // A refreshed server response can remove a booking while keeping the course.
  rows = rows.map(row => row.id === 42 ? { ...row, bookingStatus: null } : row);
  page.rerender(<Page />);
  scrollCalls.length = 0;
  fireEvent.click(screen.getByTestId('button-filter-mine'));
  expect(visibleIds()).toEqual(['course-41', 'course-43']);
  expect(screen.getByTestId('status-course-filtered').textContent).toContain('Meine Plätze');
  expect(screen.queryByTestId('status-course-unavailable')).toBeNull();
  expectNoTarget();
  expect(new URLSearchParams(window.location.search).get('courseId')).toBe('42');

  page.unmount();
  render(<Page />);
  expectNoTarget();
  expect(screen.getByTestId('status-course-filtered')).toBeTruthy();
  fireEvent.click(screen.getByTestId('button-show-target-course'));
  await expectTarget(42);
  expect(window.location.search).toBe('?courseId=42');
});

test('a course removed from the plan reports unavailable without targeting another row', async () => {
  const page = open();
  await expectTarget(42);
  rows = rows.filter(row => row.id !== 42);
  scrollCalls.length = 0;
  page.rerender(<Page />);
  expect(visibleIds()).toEqual(['course-41', 'course-43']);
  expect(screen.getByTestId('status-course-unavailable').textContent).toContain('nicht verfügbar');
  expect(screen.queryByTestId('status-course-filtered')).toBeNull();
  expectNoTarget();
  fireEvent.click(screen.getByTestId('button-filter-mine'));
  expectNoTarget();
  page.unmount();
  render(<Page />);
  expectNoTarget();
  expect(screen.getByTestId('status-course-unavailable')).toBeTruthy();
  expect(new URLSearchParams(window.location.search).get('courseId')).toBe('42');
  expect(listCourses).toHaveBeenLastCalledWith({ courseId: 42 });
});

test('an ordinary course URL neither marks nor scrolls a course', () => {
  open('');
  expect(visibleIds()).toHaveLength(3);
  expectNoTarget();
  expect(listCourses).toHaveBeenLastCalledWith(undefined);
  expect(screen.queryByTestId('status-course-unavailable')).toBeNull();
  fireEvent.click(screen.getByTestId('button-filter-mine'));
  expectNoTarget();
  expect(window.location.search).toBe('?filter=mine');
});
