export type CourseImportSession<Parsed, Result> = {
  version: 1;
  studioId: number;
  fileName: string;
  parsed: Parsed;
  duration: string;
  capacity: string;
  roomMap: Record<string, string>;
  progress: number;
  createdLines: number[];
  skippedLines: number[];
  results: Result[];
};

type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function courseImportSessionKey(studioId: number) {
  return `fiudia:course-import:v1:${studioId}`;
}

export function loadCourseImportSession<Parsed, Result>(
  studioId: number,
  storage: SessionStorage = window.localStorage,
): CourseImportSession<Parsed, Result> | null {
  try {
    const raw = storage.getItem(courseImportSessionKey(studioId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<CourseImportSession<Parsed, Result>>;
    const parsed = value.parsed as { rows?: unknown[] } | null | undefined;
    if (value.version !== 1 || value.studioId !== studioId ||
      typeof value.fileName !== 'string' || !parsed || !Array.isArray(parsed.rows) ||
      typeof value.duration !== 'string' || typeof value.capacity !== 'string' ||
      !value.roomMap || typeof value.roomMap !== 'object' || Array.isArray(value.roomMap) ||
      typeof value.progress !== 'number' || !Number.isInteger(value.progress) || value.progress < 0 ||
      !Array.isArray(value.createdLines) || !Array.isArray(value.skippedLines) ||
      !Array.isArray(value.results)) return null;
    return value as CourseImportSession<Parsed, Result>;
  } catch {
    return null;
  }
}

export function saveCourseImportSession<Parsed, Result>(
  session: CourseImportSession<Parsed, Result>,
  storage: SessionStorage = window.localStorage,
): boolean {
  try {
    storage.setItem(courseImportSessionKey(session.studioId), JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

export function clearCourseImportSession(studioId: number, storage: SessionStorage = window.localStorage) {
  try { storage.removeItem(courseImportSessionKey(studioId)); } catch { /* storage may be unavailable */ }
}
