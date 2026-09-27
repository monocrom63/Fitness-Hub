import { and, count, eq, inArray, sql } from "drizzle-orm";
import {
  db, pulseMessagesTable, trainerAbsenceCoursesTable, trainerAbsencesTable,
} from "@workspace/db";

export function trainerLockKey(studioId: number, instructor: string) {
  return `fiudia-trainer:${studioId}:${instructor.trim().toLocaleLowerCase("de-DE")}`;
}

export function trainerAbsenceOverlapsCourse(startsAt: Date, endsAt: Date) {
  return sql<boolean>`
    (${startsAt}::timestamptz AT TIME ZONE 'Europe/Berlin') < (${trainerAbsencesTable.toDate} + 1)::timestamp
    AND (${endsAt}::timestamptz AT TIME ZONE 'Europe/Berlin') > ${trainerAbsencesTable.fromDate}::timestamp
  `;
}

export async function isTrainerAbsentForCourse(
  studioId: number,
  instructor: string,
  startsAt: Date,
  endsAt: Date,
  database: Pick<typeof db, "select"> = db,
) {
  const [absence] = await database.select({ id: trainerAbsencesTable.id })
    .from(trainerAbsencesTable).where(and(
      eq(trainerAbsencesTable.studioId, studioId),
      sql<boolean>`lower(btrim(${trainerAbsencesTable.instructor})) = lower(${instructor.trim()})`,
      trainerAbsenceOverlapsCourse(startsAt, endsAt),
    )).limit(1);
  return absence !== undefined;
}

export async function retireTrainerAlertIfResolved(
  absenceId: number,
  pulseMessageId: number | null,
  database: Pick<typeof db, "select" | "update"> = db,
) {
  if (!pulseMessageId) return;
  const [remaining] = await database.select({ total: count() })
    .from(trainerAbsenceCoursesTable).where(and(
      eq(trainerAbsenceCoursesTable.absenceId, absenceId),
      inArray(trainerAbsenceCoursesTable.status, ["open", "requested"]),
    ));
  if (remaining.total === 0) await database.update(pulseMessagesTable)
    .set({ retractedAt: new Date() })
    .where(eq(pulseMessagesTable.id, pulseMessageId));
}

// Room-closure cancellation already owns the member notice. Just settle the
// overlapping trainer work item, without producing a second notification.
export async function settleCancelledTrainerCourse(
  courseId: number,
  managerStaffId: number,
  database: Pick<typeof db, "select" | "update"> = db,
) {
  const pending = await database.select({
    id: trainerAbsenceCoursesTable.id,
    absenceId: trainerAbsenceCoursesTable.absenceId,
    pulseMessageId: trainerAbsencesTable.pulseMessageId,
  }).from(trainerAbsenceCoursesTable)
    .innerJoin(trainerAbsencesTable, eq(trainerAbsenceCoursesTable.absenceId, trainerAbsencesTable.id))
    .where(and(
      eq(trainerAbsenceCoursesTable.courseId, courseId),
      inArray(trainerAbsenceCoursesTable.status, ["open", "requested"]),
    )).for("update");
  if (!pending.length) return;
  await database.update(trainerAbsenceCoursesTable).set({
    status: "cancelled", candidateName: null, resolvedAt: new Date(),
    resolvedByStaffId: managerStaffId,
  }).where(inArray(trainerAbsenceCoursesTable.id, pending.map((item) => item.id)));
  const retired = new Set<number>();
  for (const item of pending) {
    if (retired.has(item.absenceId)) continue;
    retired.add(item.absenceId);
    await retireTrainerAlertIfResolved(item.absenceId, item.pulseMessageId, database);
  }
}