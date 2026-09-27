import type { MemberCourse } from '@workspace/api-client-react';

export type CourseFilter = 'all' | 'mine';

export function readCourseLocation(search: string): { targetId: number | null; filter: CourseFilter } {
  const params = new URLSearchParams(search);
  const requestedId = params.get('courseId');
  const parsedId = requestedId && /^[1-9]\d*$/.test(requestedId) ? Number(requestedId) : null;
  return {
    targetId: parsedId !== null && Number.isSafeInteger(parsedId) ? parsedId : null,
    filter: params.get('filter') === 'mine' ? 'mine' : 'all',
  };
}

export function courseFilterHref(search: string, filter: CourseFilter): string {
  const params = new URLSearchParams(search);
  if (filter === 'mine') params.set('filter', 'mine');
  else params.delete('filter');
  return `/courses${params.size ? `?${params}` : ''}`;
}

export function courseDisplayState<T extends Pick<MemberCourse, 'id' | 'startsAt' | 'bookingStatus'>>(
  courses: T[],
  filter: CourseFilter,
  targetId: number | null,
) {
  const visible = courses
    .filter(course => filter === 'all' || course.bookingStatus === 'confirmed' || course.bookingStatus === 'waitlisted')
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  return {
    visible,
    targetExists: targetId !== null && courses.some(course => course.id === targetId),
    targetVisible: targetId !== null && visible.some(course => course.id === targetId),
  };
}