import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetCourseEditPushDeliveriesResponse,
  ListCourseEditPushHistoryQueryParams,
  ListCourseEditPushHistoryResponse,
  RetryCourseEditPushDeliveryResponse,
  UpdateCourseBody,
  UpdateCourseParams,
  UpdateCourseResponse,
} from "@workspace/api-zod";
import {
  courseBookingsTable,
  courseEditPushDeliveriesTable,
  coursesTable,
  db,
  memberNotificationsTable,
  memberPushSubscriptionsTable,
  membersTable,
  roomClosuresTable,
  studiosTable,
} from "@workspace/db";
import {
  canAccessStudio,
  canManageCourses,
  getAccessibleStudioIds,
  getRequestUserId,
  getStaffContext,
  type StaffContext,
} from "../lib/fiudia-access";
import { closureIntersectsInterval, hasOverlappingLiveCourse } from "../lib/room-closures";
import { supersedeCourseEditPushDeliveries } from "../lib/course-edit-deliveries";
import { COURSE_EDIT_PUSH_MAX_ATTEMPTS, courseEditIdempotencyKey } from "../lib/course-edit-push";
import { isTrainerAbsentForCourse, trainerLockKey } from "../lib/trainer-scheduling";

type Dependencies = {
  database: typeof db;
  userIdFromRequest: (req: Request) => string | null;
};

const COURSE_UPDATE_FIELDS = new Set(["title", "instructor", "startsAt", "endsAt", "room", "revision"]);

function trimmedText(value: string, min: number, max: number) {
  const text = value.trim();
  return text.length >= min && text.length <= max ? text : null;
}

function noticeBody(course: {
  title: string;
  instructor: string;
  startsAt: Date;
  endsAt: Date;
  room: string;
}) {
  const date = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    dateStyle: "medium",
  }).format(course.startsAt);
  const time = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `„${course.title}“ mit ${course.instructor} am ${date}, ${time.format(course.startsAt)}–${time.format(course.endsAt)} Uhr, Raum ${course.room}.`;
}

export function createCourseEditsRouter(deps: Partial<Dependencies> = {}): IRouter {
  const router: IRouter = Router();
  const database = deps.database ?? db;
  const userIdFromRequest = deps.userIdFromRequest ?? getRequestUserId;

  async function getPushReport(courseId: number, staff: StaffContext) {
    const [course] = await database.select().from(coursesTable)
      .where(eq(coursesTable.id, courseId)).limit(1);
    if (!course || !(await canAccessStudio(staff, course.studioId, database))) return null;

    const deliveries = await database.select({
      id: courseEditPushDeliveriesTable.id,
      revision: courseEditPushDeliveriesTable.courseRevision,
      memberName: membersTable.fullName,
      status: courseEditPushDeliveriesTable.status,
      attemptCount: courseEditPushDeliveriesTable.attemptCount,
      error: courseEditPushDeliveriesTable.error,
      createdAt: courseEditPushDeliveriesTable.createdAt,
      attemptedAt: courseEditPushDeliveriesTable.attemptedAt,
      nextAttemptAt: courseEditPushDeliveriesTable.nextAttemptAt,
    }).from(courseEditPushDeliveriesTable)
      .innerJoin(membersTable, eq(membersTable.id, courseEditPushDeliveriesTable.memberId))
      .where(eq(courseEditPushDeliveriesTable.courseId, course.id))
      .orderBy(desc(courseEditPushDeliveriesTable.createdAt), desc(courseEditPushDeliveriesTable.id));

    const retryableDeliveries = await database.select({
      id: courseEditPushDeliveriesTable.id,
    }).from(courseEditPushDeliveriesTable)
      .innerJoin(coursesTable, eq(coursesTable.id, courseEditPushDeliveriesTable.courseId))
      .innerJoin(courseBookingsTable, and(
        eq(courseBookingsTable.id, courseEditPushDeliveriesTable.bookingId),
        eq(courseBookingsTable.courseId, coursesTable.id),
      ))
      .innerJoin(membersTable, and(
        eq(membersTable.id, courseEditPushDeliveriesTable.memberId),
        eq(membersTable.id, courseBookingsTable.memberId),
      ))
      .innerJoin(memberPushSubscriptionsTable, and(
        eq(memberPushSubscriptionsTable.memberId, membersTable.id),
        eq(memberPushSubscriptionsTable.subscriptionId, courseEditPushDeliveriesTable.subscriptionId),
      ))
      .where(and(
        eq(courseEditPushDeliveriesTable.courseId, course.id),
        eq(courseEditPushDeliveriesTable.courseRevision, course.revision),
        eq(courseEditPushDeliveriesTable.status, "failed"),
        sql`${courseEditPushDeliveriesTable.attemptCount} >= ${COURSE_EDIT_PUSH_MAX_ATTEMPTS}`,
        inArray(coursesTable.status, ["scheduled", "full"]),
        sql`${coursesTable.startsAt} > now()`,
        inArray(courseBookingsTable.status, ["confirmed", "waitlisted"]),
        eq(membersTable.status, "active"),
        eq(membersTable.studioId, coursesTable.studioId),
      ));
    const retryableIds = new Set(retryableDeliveries.map((delivery) => delivery.id));

    const report = {
      courseId: course.id,
      currentRevision: course.revision,
      deliveries: deliveries.map((delivery) => ({
        ...delivery,
        canRetry: retryableIds.has(delivery.id),
      })),
    };
    return {
      course,
      report: GetCourseEditPushDeliveriesResponse.parse(report),
    };
  }

  async function manager(req: Request, res: Response): Promise<StaffContext | null> {
    const userId = userIdFromRequest(req);
    if (!userId) {
      res.status(401).json({ error: "Anmeldung erforderlich." });
      return null;
    }
    const staff = await getStaffContext(userId, database);
    if (!staff || !canManageCourses(staff)) {
      res.status(403).json({ error: "Nur Studio- und Bezirksleitungen dürfen Kurse bearbeiten." });
      return null;
    }
    return staff;
  }

  router.get("/courses/push-history", async (req, res): Promise<void> => {
    const staff = await manager(req, res);
    if (!staff) return;
    const query = ListCourseEditPushHistoryQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }

    const accessibleStudioIds = await getAccessibleStudioIds(staff, database);
    if (query.data.studioId !== undefined &&
      !accessibleStudioIds.includes(query.data.studioId)) {
      res.status(403).json({ error: "Kein Zugriff auf dieses Studio." });
      return;
    }
    const studioIds = query.data.studioId === undefined
      ? accessibleStudioIds
      : [query.data.studioId];
    if (!studioIds.length) {
      res.json([]);
      return;
    }

    const lastChangeAt = sql<Date>`max(${courseEditPushDeliveriesTable.createdAt})`;
    const rows = await database.select({
      courseId: coursesTable.id,
      title: coursesTable.title,
      studioName: studiosTable.name,
      startsAt: coursesTable.startsAt,
      lastChangeAt,
    }).from(coursesTable)
      .innerJoin(studiosTable, eq(studiosTable.id, coursesTable.studioId))
      .innerJoin(courseEditPushDeliveriesTable, eq(courseEditPushDeliveriesTable.courseId, coursesTable.id))
      .where(inArray(coursesTable.studioId, studioIds))
      .groupBy(coursesTable.id, coursesTable.title, coursesTable.startsAt, studiosTable.name)
      .orderBy(desc(lastChangeAt), desc(coursesTable.id))
      .limit(query.data.limit)
      .offset(query.data.offset);

    res.json(ListCourseEditPushHistoryResponse.parse(rows));
  });

  router.patch("/courses/:id", async (req, res): Promise<void> => {
    const staff = await manager(req, res);
    if (!staff) return;
    const params = UpdateCourseParams.safeParse(req.params);
    const requestFields = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? Object.keys(req.body as Record<string, unknown>)
      : [];
    const hasUnsupportedField = requestFields.some((key) => !COURSE_UPDATE_FIELDS.has(key));
    const body = UpdateCourseBody.safeParse(req.body);
    if (!params.success || hasUnsupportedField || !body.success) {
      res.status(400).json({ error: "Bitte gültige Kursdetails und die aktuelle Kursrevision angeben." });
      return;
    }
    const title = trimmedText(body.data.title, 2, 120);
    const instructor = trimmedText(body.data.instructor, 2, 120);
    const room = trimmedText(body.data.room, 1, 80);
    const startsAt = body.data.startsAt;
    const endsAt = body.data.endsAt;
    if (!title || !instructor || !room) {
      res.status(400).json({ error: "Bitte gültige, nicht leere Kursdetails angeben." });
      return;
    }
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      res.status(400).json({ error: "Das Kursende muss nach dem Kursstart liegen." });
      return;
    }

    const [initialCourse] = await database.select({
      id: coursesTable.id,
      studioId: coursesTable.studioId,
    }).from(coursesTable).where(eq(coursesTable.id, params.data.id)).limit(1);
    if (!initialCourse || !(await canAccessStudio(staff, initialCourse.studioId, database))) {
      res.status(404).json({ error: "Kurs nicht gefunden." });
      return;
    }

    const result = await database.transaction(async (tx) => {
      // Trainer availability is serialized before taking the course row lock.
      // This is the same lock order used by trainer-absence operations.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${trainerLockKey(initialCourse.studioId, instructor)}))`);
      const [course] = await tx.select().from(coursesTable)
        .where(eq(coursesTable.id, params.data.id)).limit(1).for("update");
      if (!course || course.studioId !== initialCourse.studioId ||
        !(await canAccessStudio(staff, course.studioId, tx))) {
        return { notFound: true as const };
      }
      if (course.revision !== body.data.revision) return { conflict: "Der Kurs wurde inzwischen geändert. Bitte lade ihn neu." };
      if (!["scheduled", "full"].includes(course.status) || course.startsAt <= new Date()) {
        return { conflict: "Nur zukünftige geplante oder ausgebuchte Kurse können bearbeitet werden." };
      }
      if (startsAt <= new Date()) {
        return { conflict: "Der Kurs muss in der Zukunft stattfinden." };
      }

      const next = { title, instructor, startsAt, endsAt, room };
      if (
        course.title === next.title &&
        course.instructor === next.instructor &&
        course.startsAt.getTime() === next.startsAt.getTime() &&
        course.endsAt.getTime() === next.endsAt.getTime() &&
        course.room === next.room
      ) {
        const [studio] = await tx.select({ name: studiosTable.name })
          .from(studiosTable).where(eq(studiosTable.id, course.studioId)).limit(1);
        return { course, studioName: studio.name };
      }

      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${
        `fiudia-room:${course.studioId}:${room}`
      }))`);
      if (await isTrainerAbsentForCourse(course.studioId, instructor, startsAt, endsAt, tx)) {
        return { conflict: "Diese Trainerperson ist am Kurstag abwesend." };
      }
      const closures = await tx.select({
        fromDate: roomClosuresTable.fromDate,
        toDate: roomClosuresTable.toDate,
      }).from(roomClosuresTable).where(and(
        eq(roomClosuresTable.studioId, course.studioId),
        eq(roomClosuresTable.roomName, room),
      ));
      if (closures.some((closure) => closureIntersectsInterval(closure.fromDate, closure.toDate, startsAt, endsAt))) {
        return { conflict: "Dieser Raum ist während des Kursintervalls geschlossen." };
      }
      if (await hasOverlappingLiveCourse(course.studioId, room, startsAt, endsAt, tx, course.id)) {
        return { conflict: "In diesem Raum liegt bereits ein überlappender Kurs." };
      }

      const revision = course.revision + 1;
      const [updated] = await tx.update(coursesTable).set({
        ...next,
        revision,
      }).where(and(
        eq(coursesTable.id, course.id),
        eq(coursesTable.revision, body.data.revision),
      )).returning();
      if (!updated) return { conflict: "Der Kurs wurde inzwischen geändert. Bitte lade ihn neu." };

      const recipients = await tx.select({
        bookingId: courseBookingsTable.id,
        memberId: courseBookingsTable.memberId,
      }).from(courseBookingsTable)
        .innerJoin(membersTable, eq(courseBookingsTable.memberId, membersTable.id))
        .where(and(
          eq(courseBookingsTable.courseId, course.id),
          inArray(courseBookingsTable.status, ["confirmed", "waitlisted"]),
          eq(membersTable.studioId, course.studioId),
          eq(membersTable.status, "active"),
        ));
      const titleText = "Deine Kursdetails wurden aktualisiert";
      const bodyText = `${noticeBody(next)} Öffne den aktuellen Kursplan in Fiudia, um die aktuellen Details zu sehen.`;
      // Push requests cannot be retracted once OneSignal accepts them, so do
      // not include room/time/instructor/title snapshots in the push payload.
      const pushTitle = "Dein Kursplan hat sich geändert";
      const pushBody = "Dein Kursplan hat sich geändert. Prüfe die aktuellen Details in Fiudia.";
      // Retire prior work that has not started. A request already in flight
      // remains eligible to settle truthfully; its neutral payload is safe.
      await supersedeCourseEditPushDeliveries(course.id, tx);
      if (recipients.length) {
        await tx.insert(memberNotificationsTable).values(recipients.map((recipient) => ({
          bookingId: recipient.bookingId,
          memberId: recipient.memberId,
          courseId: course.id,
          title: titleText,
          body: bodyText,
        })));

        const subscriptions = await tx.select({
          bookingId: courseBookingsTable.id,
          memberId: membersTable.id,
          subscriptionId: memberPushSubscriptionsTable.subscriptionId,
        }).from(courseBookingsTable)
          .innerJoin(membersTable, eq(courseBookingsTable.memberId, membersTable.id))
          .innerJoin(memberPushSubscriptionsTable, eq(memberPushSubscriptionsTable.memberId, membersTable.id))
          .where(and(
            eq(courseBookingsTable.courseId, course.id),
            inArray(courseBookingsTable.status, ["confirmed", "waitlisted"]),
            eq(membersTable.studioId, course.studioId),
            eq(membersTable.status, "active"),
          ));
        if (subscriptions.length) {
          await tx.insert(courseEditPushDeliveriesTable).values(subscriptions.map((recipient) => ({
            courseId: course.id,
            courseRevision: revision,
            bookingId: recipient.bookingId,
            memberId: recipient.memberId,
            subscriptionId: recipient.subscriptionId,
            title: pushTitle,
            body: pushBody,
            idempotencyKey: courseEditIdempotencyKey(
              course.id, revision, recipient.bookingId, recipient.subscriptionId,
            ),
          })));
        }
      }

      const [studio] = await tx.select({ name: studiosTable.name })
        .from(studiosTable).where(eq(studiosTable.id, course.studioId)).limit(1);
      return { course: updated, studioName: studio.name };
    });

    if ("notFound" in result) {
      res.status(404).json({ error: "Kurs nicht gefunden." });
      return;
    }
    if ("conflict" in result) {
      res.status(409).json({ error: result.conflict });
      return;
    }
    res.json(UpdateCourseResponse.parse({
      ...result.course,
      studioName: result.studioName,
      startsAt: result.course.startsAt.toISOString(),
      endsAt: result.course.endsAt.toISOString(),
    }));
  });

  router.get("/courses/:id/push-deliveries", async (req, res): Promise<void> => {
    const staff = await manager(req, res);
    if (!staff) return;
    const courseId = Number(req.params.id);
    if (!Number.isSafeInteger(courseId) || courseId <= 0) {
      res.status(404).json({ error: "Kurs nicht gefunden." });
      return;
    }
    const result = await getPushReport(courseId, staff);
    if (!result) {
      res.status(404).json({ error: "Kurs nicht gefunden." });
      return;
    }
    res.json(result.report);
  });

  router.post("/courses/:id/push-deliveries/:deliveryId/retry", async (req, res): Promise<void> => {
    const staff = await manager(req, res);
    if (!staff) return;
    const courseId = Number(req.params.id);
    const deliveryId = Number(req.params.deliveryId);
    if (!Number.isSafeInteger(courseId) || courseId <= 0 ||
      !Number.isSafeInteger(deliveryId) || deliveryId <= 0) {
      res.status(404).json({ error: "Kurs oder Push-Zustellung nicht gefunden." });
      return;
    }

    const [initialCourse] = await database.select().from(coursesTable)
      .where(eq(coursesTable.id, courseId)).limit(1);
    if (!initialCourse || !(await canAccessStudio(staff, initialCourse.studioId, database))) {
      res.status(404).json({ error: "Kurs nicht gefunden." });
      return;
    }

    const retryResult = await database.transaction(async (tx) => {
      // Keep the same lock order as course edits: course first, then delivery.
      const [course] = await tx.select().from(coursesTable)
        .where(eq(coursesTable.id, courseId)).limit(1).for("update");
      if (!course || course.studioId !== initialCourse.studioId ||
        !(await canAccessStudio(staff, course.studioId, tx))) {
        return { notFound: "course" as const };
      }
      const [delivery] = await tx.select().from(courseEditPushDeliveriesTable)
        .where(and(
          eq(courseEditPushDeliveriesTable.id, deliveryId),
          eq(courseEditPushDeliveriesTable.courseId, course.id),
        )).limit(1).for("update");
      if (!delivery) return { notFound: "delivery" as const };

      if (delivery.status !== "failed" || delivery.attemptCount < COURSE_EDIT_PUSH_MAX_ATTEMPTS) {
        return { conflict: true as const };
      }

      const [eligible] = await tx.select({
        id: courseEditPushDeliveriesTable.id,
      }).from(courseEditPushDeliveriesTable)
        .innerJoin(coursesTable, and(
          eq(coursesTable.id, courseEditPushDeliveriesTable.courseId),
          eq(coursesTable.id, course.id),
        ))
        .innerJoin(courseBookingsTable, and(
          eq(courseBookingsTable.id, courseEditPushDeliveriesTable.bookingId),
          eq(courseBookingsTable.courseId, course.id),
        ))
        .innerJoin(membersTable, and(
          eq(membersTable.id, courseEditPushDeliveriesTable.memberId),
          eq(membersTable.id, courseBookingsTable.memberId),
        ))
        .innerJoin(memberPushSubscriptionsTable, and(
          eq(memberPushSubscriptionsTable.memberId, membersTable.id),
          eq(memberPushSubscriptionsTable.subscriptionId, courseEditPushDeliveriesTable.subscriptionId),
        ))
        .where(and(
          eq(courseEditPushDeliveriesTable.id, delivery.id),
          eq(courseEditPushDeliveriesTable.courseId, course.id),
          eq(courseEditPushDeliveriesTable.courseRevision, course.revision),
          inArray(coursesTable.status, ["scheduled", "full"]),
          sql`${coursesTable.startsAt} > now()`,
          inArray(courseBookingsTable.status, ["confirmed", "waitlisted"]),
          eq(membersTable.status, "active"),
          eq(membersTable.studioId, course.studioId),
        ))
        .limit(1);
      if (!eligible) return { conflict: true as const };

      const [updated] = await tx.update(courseEditPushDeliveriesTable).set({
        attemptCount: 0,
        status: "pending",
        nextAttemptAt: new Date(),
        error: null,
      }).where(and(
        eq(courseEditPushDeliveriesTable.id, delivery.id),
        eq(courseEditPushDeliveriesTable.status, "failed"),
        sql`${courseEditPushDeliveriesTable.attemptCount} >= ${COURSE_EDIT_PUSH_MAX_ATTEMPTS}`,
      )).returning({ id: courseEditPushDeliveriesTable.id });
      return updated ? { queued: true as const } : { conflict: true as const };
    });

    if ("notFound" in retryResult) {
      res.status(404).json({
        error: retryResult.notFound === "course" ? "Kurs nicht gefunden." : "Push-Zustellung nicht gefunden.",
      });
      return;
    }
    if ("conflict" in retryResult) {
      res.status(409).json({ error: "Diese Push-Zustellung kann nicht erneut versendet werden." });
      return;
    }

    const result = await getPushReport(courseId, staff);
    if (!result) {
      res.status(404).json({ error: "Kurs nicht gefunden." });
      return;
    }
    res.json(RetryCourseEditPushDeliveryResponse.parse(result.report));
  });

  return router;
}

export default createCourseEditsRouter();