import type { MemberCourse } from '@workspace/api-client-react';

export type CourseFilter = 'all' | 'mine';

export type CoursePushPayload = { courseId: number; memberId: number };

function safePositiveId(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[1-9]\d*$/.test(value)
      ? Number(value)
      : null;
  return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseCoursePushPayload(additionalData: unknown): CoursePushPayload | null {
  if (!additionalData || typeof additionalData !== 'object' || Array.isArray(additionalData)) return null;
  const data = additionalData as Record<string, unknown>;
  const courseId = safePositiveId(data.courseId);
  const memberId = safePositiveId(data.memberId);
  return courseId !== null && memberId !== null ? { courseId, memberId } : null;
}

export function coursePushTarget(courseId: number): string {
  return `/courses?courseId=${courseId}`;
}

export class CoursePushClickRouter {
  private currentListener: { memberId: number; navigate: (target: string) => void } | null = null;
  private bufferedPayload: CoursePushPayload | null = null;

  receive(additionalData: unknown) {
    const payload = parseCoursePushPayload(additionalData);
    if (!payload) return;
    const listener = this.currentListener;
    if (!listener) {
      this.bufferedPayload = payload;
      return;
    }
    if (listener.memberId === payload.memberId) {
      listener.navigate(coursePushTarget(payload.courseId));
    }
  }

  subscribe(memberId: unknown, navigate: (target: string) => void) {
    const safeMemberId = safePositiveId(memberId);
    if (safeMemberId === null) return () => {};
    const listener = { memberId: safeMemberId, navigate };
    this.currentListener = listener;
    if (this.bufferedPayload) {
      const payload = this.bufferedPayload;
      this.bufferedPayload = null;
      if (payload.memberId === safeMemberId) {
        listener.navigate(coursePushTarget(payload.courseId));
      }
    }
    return () => {
      if (this.currentListener === listener) this.currentListener = null;
    };
  }

  clear() {
    this.bufferedPayload = null;
    this.currentListener = null;
  }
}

export function readCourseLocation(search: string): { targetId: number | null; filter: CourseFilter } {
  const params = new URLSearchParams(search);
  const requestedId = params.get('courseId');
  const parsedId = requestedId && /^[1-9]\d*$/.test(requestedId) ? Number(requestedId) : null;
  return {
    targetId: parsedId !== null && Number.isSafeInteger(parsedId) ? parsedId : null,
    filter: params.get('filter') === 'mine' ? 'mine' : 'all',
  };
}

export function courseQueryParams(search: string): { courseId: number } | undefined {
  const { targetId } = readCourseLocation(search);
  return targetId === null ? undefined : { courseId: targetId };
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