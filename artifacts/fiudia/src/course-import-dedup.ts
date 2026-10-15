type CourseIdentity = {
  title: string;
  instructor: string;
  startsAt: string;
};

type ImportRowIdentity = CourseIdentity & { line: number };

function normalize(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-DE');
}

function identityKey(course: CourseIdentity): string | null {
  const start = new Date(course.startsAt);
  if (Number.isNaN(start.getTime())) return null;
  return JSON.stringify([normalize(course.title), normalize(course.instructor), start.toISOString()]);
}

export function findDuplicateCourseLines(rows: ImportRowIdentity[], existing: CourseIdentity[]): Set<number> {
  const seen = new Set(existing.map(identityKey).filter((key): key is string => key !== null));
  const duplicates = new Set<number>();
  for (const row of rows) {
    const key = identityKey(row);
    if (!key) continue;
    if (seen.has(key)) duplicates.add(row.line);
    else seen.add(key);
  }
  return duplicates;
}
