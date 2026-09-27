import { and, asc, count, desc, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateTrainerAbsenceBody, CreateTrainerAbsenceResponse, ListTrainerAbsencesResponse,
  ListTrainerReplacementCandidatesResponse, RequestTrainerReplacementBody,
  RequestTrainerReplacementResponse, ResolveTrainerAbsenceCourseBody,
  ResolveTrainerAbsenceCourseResponse, RetryTrainerAbsencePushResponse,
} from "@workspace/api-zod";
import {
  courseBookingsTable, coursesTable, db, memberNotificationsTable,
  memberPushSubscriptionsTable, pulseMessagesTable, staffTable, studiosTable,
  trainerAbsenceCoursesTable, trainerAbsencePushDeliveriesTable, trainerAbsencesTable,
} from "@workspace/db";
import {
  canAccessStudio, canManageCourses, getAccessibleStudioIds, getRequestUserId,
  getStaffContext, type StaffContext,
} from "../lib/fiudia-access";
import { processTrainerAbsencePush, trainerDecisionNotice } from "../lib/trainer-absence-push";
import { isTrainerAbsentForCourse, retireTrainerAlertIfResolved, trainerLockKey } from "../lib/trainer-scheduling";

type Dependencies = {
  database: typeof db;
  userIdFromRequest: (req: Request) => string | null;
  processPush: (absenceCourseId: number) => Promise<void>;
};
const TURNAROUND_MS = 30 * 60 * 1000;

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(new Date(`${value}T12:00:00Z`).getTime()) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

function berlinDate(value: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function createTrainerAbsencesRouter(deps: Partial<Dependencies> = {}): IRouter {
  const router: IRouter = Router();
  const database = deps.database ?? db;
  const userIdFromRequest = deps.userIdFromRequest ?? getRequestUserId;
  const processPush = deps.processPush ?? processTrainerAbsencePush;

  async function manager(req: Request, res: Response): Promise<StaffContext | null> {
    const userId = userIdFromRequest(req);
    if (!userId) { res.status(401).json({ error: "Bitte melde dich an." }); return null; }
    const staff = await getStaffContext(userId, database);
    if (!staff || !canManageCourses(staff)) {
      res.status(403).json({ error: "Nur Studio- und Bezirksleitungen dürfen Trainerabwesenheiten verwalten." });
      return null;
    }
    return staff;
  }

  async function courseView(absenceCourseId: number) {
    const [row] = await database.select({
      id: trainerAbsenceCoursesTable.id,
      courseId: trainerAbsenceCoursesTable.courseId,
      originalInstructor: trainerAbsenceCoursesTable.originalInstructor,
      status: trainerAbsenceCoursesTable.status,
      candidateName: trainerAbsenceCoursesTable.candidateName,
      title: coursesTable.title,
      instructor: coursesTable.instructor,
      startsAt: coursesTable.startsAt,
      endsAt: coursesTable.endsAt,
    }).from(trainerAbsenceCoursesTable)
      .innerJoin(coursesTable, eq(trainerAbsenceCoursesTable.courseId, coursesTable.id))
      .where(eq(trainerAbsenceCoursesTable.id, absenceCourseId)).limit(1);
    if (!row) return null;
    const [bookings] = await database.select({ total: count() }).from(courseBookingsTable)
      .where(and(eq(courseBookingsTable.courseId, row.courseId),
        inArray(courseBookingsTable.status, ["confirmed", "waitlisted"])));
    const deliveries = await database.select({ status: trainerAbsencePushDeliveriesTable.status })
      .from(trainerAbsencePushDeliveriesTable)
      .where(eq(trainerAbsencePushDeliveriesTable.absenceCourseId, row.id));
    return {
      ...row, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(),
      bookingCount: bookings.total,
      pushSent: deliveries.filter((item) => item.status === "sent").length,
      pushFailed: deliveries.filter((item) => item.status === "failed").length,
      pushPending: deliveries.filter((item) => item.status === "pending" || item.status === "sending").length,
    };
  }

  async function absenceView(id: number) {
    const [absence] = await database.select({
      id: trainerAbsencesTable.id, studioId: trainerAbsencesTable.studioId,
      studioName: studiosTable.name, instructor: trainerAbsencesTable.instructor,
      fromDate: trainerAbsencesTable.fromDate, toDate: trainerAbsencesTable.toDate,
      createdAt: trainerAbsencesTable.createdAt,
    }).from(trainerAbsencesTable)
      .innerJoin(studiosTable, eq(trainerAbsencesTable.studioId, studiosTable.id))
      .where(eq(trainerAbsencesTable.id, id)).limit(1);
    if (!absence) return null;
    const affected = await database.select({ id: trainerAbsenceCoursesTable.id })
      .from(trainerAbsenceCoursesTable)
      .innerJoin(coursesTable, eq(trainerAbsenceCoursesTable.courseId, coursesTable.id))
      .where(eq(trainerAbsenceCoursesTable.absenceId, id))
      .orderBy(asc(coursesTable.startsAt));
    return {
      ...absence, createdAt: absence.createdAt.toISOString(),
      courses: (await Promise.all(affected.map((row) => courseView(row.id)))).filter((row) => row !== null),
    };
  }

  async function accessibleCourse(staff: StaffContext, req: Request, res: Response) {
    const id = Number(req.params.id);
    const courseId = Number(req.params.courseId);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(courseId) || courseId < 1) {
      res.status(404).json({ error: "Betroffener Kurs nicht gefunden." }); return null;
    }
    const [row] = await database.select({
      id: trainerAbsenceCoursesTable.id,
      status: trainerAbsenceCoursesTable.status,
      candidateName: trainerAbsenceCoursesTable.candidateName,
      absenceId: trainerAbsencesTable.id,
      studioId: trainerAbsencesTable.studioId,
      originalInstructor: trainerAbsenceCoursesTable.originalInstructor,
      pulseMessageId: trainerAbsencesTable.pulseMessageId,
      startsAt: coursesTable.startsAt,
      endsAt: coursesTable.endsAt,
      title: coursesTable.title,
      instructor: coursesTable.instructor,
      courseStatus: coursesTable.status,
    }).from(trainerAbsenceCoursesTable)
      .innerJoin(trainerAbsencesTable, eq(trainerAbsenceCoursesTable.absenceId, trainerAbsencesTable.id))
      .innerJoin(coursesTable, eq(trainerAbsenceCoursesTable.courseId, coursesTable.id))
      .where(and(eq(trainerAbsenceCoursesTable.absenceId, id),
        eq(trainerAbsenceCoursesTable.courseId, courseId),
        eq(coursesTable.studioId, trainerAbsencesTable.studioId))).limit(1);
    if (!row || !(await canAccessStudio(staff, row.studioId, database))) {
      res.status(404).json({ error: "Betroffener Kurs nicht gefunden." }); return null;
    }
    return row;
  }

  async function candidates(studioId: number, course: { courseId: number; startsAt: Date; endsAt: Date; originalInstructor: string }) {
    const sameName = (first: string, second: string) =>
      first.trim().toLocaleLowerCase("de-DE") === second.trim().toLocaleLowerCase("de-DE");
    const names = await database.selectDistinct({ name: coursesTable.instructor })
      .from(coursesTable).where(eq(coursesTable.studioId, studioId));
    const day = berlinDate(course.startsAt);
    const conflicts = await database.select({
      name: coursesTable.instructor, title: coursesTable.title,
    }).from(coursesTable).where(and(
      eq(coursesTable.studioId, studioId), ne(coursesTable.status, "cancelled"),
      ne(coursesTable.id, course.courseId),
      lt(coursesTable.startsAt, new Date(course.endsAt.getTime() + TURNAROUND_MS)),
      gt(coursesTable.endsAt, new Date(course.startsAt.getTime() - TURNAROUND_MS)),
    ));
    const absent = await database.select({ name: trainerAbsencesTable.instructor })
      .from(trainerAbsencesTable).where(and(eq(trainerAbsencesTable.studioId, studioId),
        sql<boolean>`${trainerAbsencesTable.fromDate} <= ${day}::date`,
        sql<boolean>`${trainerAbsencesTable.toDate} >= ${day}::date`));
    return names.filter((item) => !sameName(item.name, course.originalInstructor)).map(({ name }) => {
      const absence = absent.some((item) => sameName(item.name, name));
      const conflict = conflicts.find((item) => sameName(item.name, name));
      return {
        name, available: !absence && !conflict,
        reason: absence ? "Für diesen Tag nicht verfügbar" :
          conflict ? `Hat bereits „${conflict.title}“ (30 Minuten Wechselzeit)` : null,
      };
    }).sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name, "de"));
  }

  router.get("/trainer-absences", async (req, res): Promise<void> => {
    const staff = await manager(req, res);
    if (!staff) return;
    const studioIds = await getAccessibleStudioIds(staff, database);
    const rows = studioIds.length ? await database.select({ id: trainerAbsencesTable.id })
      .from(trainerAbsencesTable)
      .where(inArray(trainerAbsencesTable.studioId, studioIds))
      .orderBy(desc(trainerAbsencesTable.id)).limit(50) : [];
    res.json(ListTrainerAbsencesResponse.parse(
      (await Promise.all(rows.map((row) => absenceView(row.id)))).filter((item) => item !== null),
    ));
  });

  router.post("/trainer-absences", async (req, res): Promise<void> => {
    const staff = await manager(req, res);
    if (!staff) return;
    const parsed = CreateTrainerAbsenceBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Ungültige Abwesenheit." }); return; }
    const { studioId } = parsed.data;
    const fromDate = req.body.fromDate as string;
    const toDate = req.body.toDate as string;
    const instructor = parsed.data.instructor.trim();
    const today = berlinDate(new Date());
    if (instructor.length < 2 || !validDate(fromDate) || !validDate(toDate) ||
      fromDate > toDate || toDate < today ||
      (new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86400000 > 30) {
      res.status(400).json({ error: "Bitte einen gültigen Zeitraum von höchstens 31 Tagen angeben." }); return;
    }
    if (!(await canAccessStudio(staff, studioId, database))) {
      res.status(403).json({ error: "Kein Zugriff auf dieses Studio." }); return;
    }
    const result = await database.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${trainerLockKey(studioId, instructor)}))`);
      const courses = await tx.select({
        id: coursesTable.id, title: coursesTable.title, instructor: coursesTable.instructor,
      }).from(coursesTable).where(and(
        eq(coursesTable.studioId, studioId),
        sql<boolean>`lower(btrim(${coursesTable.instructor})) = lower(${instructor})`,
        ne(coursesTable.status, "cancelled"), gt(coursesTable.startsAt, new Date()),
        sql<boolean>`(${coursesTable.startsAt} AT TIME ZONE 'Europe/Berlin')::date BETWEEN ${fromDate}::date AND ${toDate}::date`,
      )).orderBy(asc(coursesTable.startsAt)).for("update");
      if (!courses.length) return { error: "Für diese Trainerperson gibt es im Zeitraum keine bevorstehenden Kurse." };
      const [overlapping] = await tx.select({ id: trainerAbsencesTable.id })
        .from(trainerAbsencesTable).where(and(
          eq(trainerAbsencesTable.studioId, studioId),
          sql<boolean>`lower(btrim(${trainerAbsencesTable.instructor})) = lower(${instructor})`,
          sql<boolean>`${trainerAbsencesTable.fromDate} <= ${toDate}::date`,
          sql<boolean>`${trainerAbsencesTable.toDate} >= ${fromDate}::date`,
        )).limit(1);
      if (overlapping) return { error: "Für diese Person wurde bereits eine überlappende Abwesenheit gemeldet." };
      const [absence] = await tx.insert(trainerAbsencesTable).values({
        studioId, instructor, fromDate, toDate, createdByStaffId: staff.id,
      }).returning();
      await tx.insert(trainerAbsenceCoursesTable).values(courses.map((course) => ({
        absenceId: absence.id, courseId: course.id, originalInstructor: course.instructor,
      })));
      const [studio] = await tx.select({ name: studiosTable.name })
        .from(studiosTable).where(eq(studiosTable.id, studioId)).limit(1);
      // Pulse's managers-only audience prevents medical information reaching other staff.
      const [pulse] = await tx.insert(pulseMessagesTable).values({
        organizationId: staff.organizationId, studioId, authorStaffId: staff.id,
        title: "Trainer-Ausfall: Kurse ohne Besetzung",
        body: `${instructor} ist vom ${fromDate} bis ${toDate} krank gemeldet. ${courses.length} ${courses.length === 1 ? "Kurs" : "Kurse"} ohne Trainer:in. Bitte Vertretungen im Team-Bereich klären.`,
        priority: "urgent", audience: "managers",
      }).returning({ id: pulseMessagesTable.id });
      await tx.update(trainerAbsencesTable).set({ pulseMessageId: pulse.id })
        .where(eq(trainerAbsencesTable.id, absence.id));
      return { id: absence.id, studio: studio?.name ?? "" };
    });
    if ("error" in result) { res.status(409).json({ error: result.error }); return; }
    res.status(201).json(CreateTrainerAbsenceResponse.parse(await absenceView(result.id!)));
  });

  router.get("/trainer-absences/:id/courses/:courseId/candidates", async (req, res): Promise<void> => {
    const staff = await manager(req, res);
    if (!staff) return;
    const row = await accessibleCourse(staff, req, res);
    if (!row) return;
    res.json(ListTrainerReplacementCandidatesResponse.parse(await candidates(row.studioId, {
      courseId: Number(req.params.courseId), startsAt: row.startsAt, endsAt: row.endsAt,
      originalInstructor: row.originalInstructor,
    })));
  });

  router.post("/trainer-absences/:id/courses/:courseId/request", async (req, res): Promise<void> => {
    const staff = await manager(req, res);
    if (!staff) return;
    const row = await accessibleCourse(staff, req, res);
    if (!row) return;
    if (row.courseStatus === "cancelled" || row.instructor !== row.originalInstructor ||
      row.startsAt <= new Date()) {
      res.status(409).json({ error: "Der Kurs wurde bereits geändert. Bitte neu laden." }); return;
    }
    const parsed = RequestTrainerReplacementBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Trainerperson fehlt." }); return; }
    const candidateName = parsed.data.candidateName.trim();
    const available = (await candidates(row.studioId, {
      courseId: Number(req.params.courseId), startsAt: row.startsAt, endsAt: row.endsAt,
      originalInstructor: row.originalInstructor,
    })).find((candidate) => candidate.name === candidateName && candidate.available);
    if (!available) { res.status(409).json({ error: "Diese Person ist für den Kurs nicht verfügbar." }); return; }
    const [updated] = await database.update(trainerAbsenceCoursesTable)
      .set({ status: "requested", candidateName })
      .where(and(eq(trainerAbsenceCoursesTable.id, row.id),
        inArray(trainerAbsenceCoursesTable.status, ["open", "requested"])))
      .returning({ id: trainerAbsenceCoursesTable.id });
    if (!updated) { res.status(409).json({ error: "Der Kurs wurde bereits bearbeitet." }); return; }
    res.json(RequestTrainerReplacementResponse.parse(await courseView(row.id)));
  });

  router.post("/trainer-absences/:id/courses/:courseId/resolve", async (req, res): Promise<void> => {
    const staff = await manager(req, res);
    if (!staff) return;
    const row = await accessibleCourse(staff, req, res);
    if (!row) return;
    const parsed = ResolveTrainerAbsenceCourseBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Ungültige Entscheidung." }); return; }
    const { action } = parsed.data;
    const externalName = parsed.data.externalName?.trim() ?? "";
    const candidateName = parsed.data.candidateName?.trim() ?? "";
    if (action === "replace" && candidateName.length < 2) {
      res.status(400).json({ error: "Bitte die angefragte Trainerperson bestätigen." }); return;
    }
    if (action !== "replace" && candidateName) {
      res.status(400).json({ error: "Ein Kandidatenname ist nur bei einer Vertretung zulässig." }); return;
    }
    if (action === "external" && (externalName.length < 2 ||
      trainerLockKey(row.studioId, externalName) === trainerLockKey(row.studioId, row.originalInstructor))) {
      res.status(400).json({ error: "Bitte den Namen der externen Vertretung eintragen." }); return;
    }
    if (action !== "external" && externalName) {
      res.status(400).json({ error: "Ein externer Name ist nur für externe Vertretungen zulässig." }); return;
    }
    const result = await database.transaction(async (tx) => {
      const [lockedCourse] = await tx.select().from(coursesTable)
        .where(eq(coursesTable.id, Number(req.params.courseId))).for("update").limit(1);
      const [decision] = await tx.select().from(trainerAbsenceCoursesTable)
        .where(eq(trainerAbsenceCoursesTable.id, row.id)).for("update").limit(1);
      if (!lockedCourse || !decision || !["open", "requested"].includes(decision.status) ||
        lockedCourse.status === "cancelled" || lockedCourse.startsAt <= new Date() ||
        lockedCourse.instructor !== decision.originalInstructor || lockedCourse.studioId !== row.studioId) {
        return { error: "Der Kurs wurde bereits geändert. Bitte neu laden." };
      }
      if (action === "replace") {
        if (decision.status !== "requested" || !decision.candidateName) {
          return { error: "Bitte zuerst eine Trainerperson anfragen und ihre Zusage eintragen." };
        }
        if (decision.candidateName !== candidateName) {
          return { error: "Die Anfrage wurde inzwischen geändert. Bitte die neue Trainerperson prüfen." };
        }
        // Serialize assignment and overlapping sick reports for this trainer
        // across separate courses before doing the final availability check.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${trainerLockKey(row.studioId, decision.candidateName)}))`);
        const pool = await candidates(row.studioId, {
          courseId: lockedCourse.id, startsAt: lockedCourse.startsAt, endsAt: lockedCourse.endsAt,
          originalInstructor: decision.originalInstructor,
        });
        if (!pool.some((candidate) => candidate.name === decision.candidateName && candidate.available)) {
          return { error: "Die angefragte Person ist inzwischen nicht mehr verfügbar." };
        }
      } else if (action === "external") {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${trainerLockKey(row.studioId, externalName)}))`);
        if (await isTrainerAbsentForCourse(row.studioId, externalName, lockedCourse.startsAt, tx)) {
          return { error: "Die externe Vertretung ist für diesen Kurstag ebenfalls abwesend." };
        }
      }
      const nextInstructor = action === "replace" ? decision.candidateName! :
        action === "external" ? externalName : lockedCourse.instructor;
      const status = action === "cancel" ? "cancelled" :
        action === "external" ? "external" : "replaced";
      const activeBookings = await tx.select({
        id: courseBookingsTable.id, memberId: courseBookingsTable.memberId,
      }).from(courseBookingsTable).where(and(
        eq(courseBookingsTable.courseId, lockedCourse.id),
        inArray(courseBookingsTable.status, ["confirmed", "waitlisted"]),
      ));
      const notice = trainerDecisionNotice(lockedCourse.title, status, nextInstructor);
      await tx.update(coursesTable).set(action === "cancel"
        ? { status: "cancelled", enrolled: 0 } : { instructor: nextInstructor })
        .where(eq(coursesTable.id, lockedCourse.id));
      if (action === "cancel") {
        await tx.update(courseBookingsTable).set({ status: "cancelled" }).where(and(
          eq(courseBookingsTable.courseId, lockedCourse.id),
          inArray(courseBookingsTable.status, ["confirmed", "waitlisted"]),
        ));
      }
      await tx.update(trainerAbsenceCoursesTable).set({
        status, candidateName: action === "replace" ? nextInstructor :
          action === "external" ? nextInstructor : null,
        resolvedAt: new Date(), resolvedByStaffId: staff.id,
      }).where(eq(trainerAbsenceCoursesTable.id, decision.id));
      if (activeBookings.length) {
        await tx.insert(memberNotificationsTable).values(activeBookings.map((booking) => ({
          bookingId: booking.id, memberId: booking.memberId, courseId: lockedCourse.id,
          title: notice.title, body: notice.body,
        })));
        const subscriptions = await tx.select({
          memberId: memberPushSubscriptionsTable.memberId,
          subscriptionId: memberPushSubscriptionsTable.subscriptionId,
        }).from(memberPushSubscriptionsTable)
          .where(inArray(memberPushSubscriptionsTable.memberId, activeBookings.map((b) => b.memberId)));
        const bookingByMember = new Map(activeBookings.map((booking) => [booking.memberId, booking.id]));
        if (subscriptions.length) await tx.insert(trainerAbsencePushDeliveriesTable)
          .values(subscriptions.map((subscription) => ({
            absenceCourseId: decision.id, memberId: subscription.memberId,
            bookingId: bookingByMember.get(subscription.memberId)!,
            subscriptionId: subscription.subscriptionId,
          })));
      }
      await retireTrainerAlertIfResolved(row.absenceId, row.pulseMessageId, tx);
      return { id: decision.id };
    });
    if ("error" in result) { res.status(409).json({ error: result.error }); return; }
    try { await processPush(row.id); }
    catch (error) {
      req.log?.error({ err: error, absenceCourseId: row.id }, "Trainer push dispatch interrupted; delivery remains retryable");
    }
    res.json(ResolveTrainerAbsenceCourseResponse.parse(await courseView(row.id)));
  });

  router.post("/trainer-absences/:id/courses/:courseId/push/retry", async (req, res): Promise<void> => {
    const staff = await manager(req, res);
    if (!staff) return;
    const row = await accessibleCourse(staff, req, res);
    if (!row) return;
    if (!["replaced", "external", "cancelled"].includes(row.status)) {
      res.status(409).json({ error: "Dieser Kurs ist noch nicht geklärt." }); return;
    }
    try { await processPush(row.id); }
    catch (error) {
      req.log?.error({ err: error, absenceCourseId: row.id }, "Trainer push retry interrupted");
      res.status(503).json({ error: "Push-Versand nicht erreichbar. Bitte später erneut versuchen." }); return;
    }
    res.json(RetryTrainerAbsencePushResponse.parse(await courseView(row.id)));
  });

  return router;
}

export default createTrainerAbsencesRouter();