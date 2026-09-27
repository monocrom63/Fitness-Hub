import { and, eq, ne, sql } from "drizzle-orm";
import { coursesTable, db, memberNotificationsTable, roomClosuresTable } from "@workspace/db";

const TIME_ZONE = "Europe/Berlin";

function localParts(instant: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant).reduce<Record<string, number>>((parts, item) => {
    if (item.type !== "literal") parts[item.type] = Number(item.value);
    return parts;
  }, {});
}

/** Resolve midnight in the studio's local calendar (including DST transitions). */
export function localDateBoundary(dateString: string): Date {
  const [year, month, day] = dateString.split("-").map(Number);
  const desiredUtc = Date.UTC(year, month - 1, day);
  let guess = desiredUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = localParts(new Date(guess));
    const representedUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const offset = representedUtc - guess;
    const adjusted = desiredUtc - offset;
    if (adjusted === guess) break;
    guess = adjusted;
  }
  return new Date(guess);
}

export function nextLocalDate(dateString: string): string {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

export function closureIntersectsInterval(
  fromDate: string,
  toDate: string,
  startsAt: Date,
  endsAt: Date,
): boolean {
  const closureStart = localDateBoundary(fromDate);
  const closureEnd = localDateBoundary(nextLocalDate(toDate));
  return startsAt < closureEnd && endsAt > closureStart;
}

export async function isRoomClosedForInterval(
  studioId: number,
  roomName: string,
  startsAt: Date,
  endsAt: Date,
  database: typeof db = db,
): Promise<boolean> {
  const closures = await database.select({
    fromDate: roomClosuresTable.fromDate,
    toDate: roomClosuresTable.toDate,
  }).from(roomClosuresTable).where(and(
    eq(roomClosuresTable.studioId, studioId),
    eq(roomClosuresTable.roomName, roomName),
  ));
  return closures.some((closure) =>
    closureIntersectsInterval(closure.fromDate, closure.toDate, startsAt, endsAt),
  );
}

export async function hasOverlappingLiveCourse(
  studioId: number,
  roomName: string,
  startsAt: Date,
  endsAt: Date,
  database: Pick<typeof db, "select"> = db,
  excludeCourseId?: number,
): Promise<boolean> {
  const [overlap] = await database.select({ id: coursesTable.id }).from(coursesTable).where(and(
    eq(coursesTable.studioId, studioId),
    eq(coursesTable.room, roomName),
    ne(coursesTable.status, "cancelled"),
    excludeCourseId === undefined ? undefined : ne(coursesTable.id, excludeCourseId),
    sql`${coursesTable.startsAt} < ${endsAt}`,
    sql`${coursesTable.endsAt} > ${startsAt}`,
  )).limit(1);
  return overlap !== undefined;
}

export async function invalidateCoursePromotionNotices(
  courseId: number,
  courseTitle: string,
  database: Pick<typeof db, "update"> = db,
): Promise<void> {
  await database.update(memberNotificationsTable).set({
    title: "Kursplatzbestätigung ungültig",
    body: `Deine frühere Bestätigung für „${courseTitle}“ ist wegen der Kursstornierung nicht mehr gültig.`,
    emailRequested: 0,
    readAt: null,
  }).where(and(
    eq(memberNotificationsTable.courseId, courseId),
    eq(memberNotificationsTable.title, "Dein Kursplatz ist bestätigt"),
  ));
}

export function resolutionRetryMatches(
  existing: {
    idempotencyKey: string;
    closureId: number;
    action: string;
    targetRoom: string | null;
    channel: string;
  },
  request: {
    idempotencyKey: string;
    closureId: number;
    action: "relocate" | "cancel";
    room?: string;
    channel: string;
  },
): boolean {
  return existing.idempotencyKey === request.idempotencyKey &&
    existing.closureId === request.closureId &&
    existing.action === request.action &&
    existing.targetRoom === (request.action === "relocate" ? request.room?.trim() ?? null : null) &&
    existing.channel === request.channel;
}