import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateStudioRoomBody,
  CreateStudioRoomClosureBody,
  CreateStudioRoomClosureParams,
  CreateStudioRoomClosureResponse,
  CreateStudioRoomParams,
  CreateStudioRoomResponse,
  DeleteStudioRoomClosureParams,
  GetClosureEmailDeliveriesParams,
  GetClosureEmailDeliveriesResponse,
  GetClosurePushReadinessParams,
  GetClosurePushReadinessResponse,
  GetClosurePushDeliveriesParams,
  GetClosurePushDeliveriesResponse,
  ListClosureAffectedCoursesParams,
  ListClosureAffectedCoursesResponse,
  ListClosureResolutionsParams,
  ListClosureResolutionsResponse,
  ListStudioRoomClosuresParams,
  ListStudioRoomClosuresResponse,
  ListStudioRoomsParams,
  ListStudioRoomsResponse,
  ResolveCourseRoomClosureBody,
  ResolveCourseRoomClosureParams,
  ResolveCourseRoomClosureResponse,
  RetryClosureEmailDeliveriesParams,
  RetryClosureEmailDeliveriesResponse,
  RetryClosurePushDeliveriesParams,
  RetryClosurePushDeliveriesResponse,
} from "@workspace/api-zod";
import {
  closureEmailDeliveriesTable,
  closurePushDeliveriesTable,
  courseBookingsTable,
  courseClosureResolutionsTable,
  coursesTable,
  db,
  memberNotificationsTable,
  memberPushSubscriptionsTable,
  membersTable,
  pulseMessagesTable,
  roomClosuresTable,
  roomsTable,
  studiosTable,
} from "@workspace/db";
import { closureEmailReadiness, getResolutionEmailStatuses, processResolutionEmails } from "../lib/closure-email";
import {
  buildClosurePushDeliveryTargets,
  closurePushReadiness,
  getResolutionPushStatuses,
  processResolutionPushDeliveries,
} from "../lib/closure-push";
import { listClosureResolutionsForStudio } from "../lib/closure-resolutions";
import {
  canAccessStudio,
  canManageCourses,
  getRequestUserId,
  getStaffContext,
  type StaffContext,
} from "../lib/fiudia-access";
import {
  closureIntersectsInterval,
  hasOverlappingLiveCourse,
  invalidateCoursePromotionNotices,
  resolutionRetryMatches,
} from "../lib/room-closures";
import { settleCancelledTrainerCourse } from "../lib/trainer-scheduling";

const router: IRouter = Router();

async function requireManager(req: Request, res: Response): Promise<StaffContext | null> {
  const userId = getRequestUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Bitte melde dich an." });
    return null;
  }
  const staff = await getStaffContext(userId);
  if (!staff) {
    res.status(403).json({ error: "Für dieses Konto ist noch kein Fiudia-Zugang hinterlegt." });
    return null;
  }
  if (!canManageCourses(staff)) {
    res.status(403).json({ error: "Nur Studio- und Bezirksleitungen dürfen Räume und Schließungen verwalten." });
    return null;
  }
  return staff;
}

async function accessibleStudio(
  staff: StaffContext,
  studioId: number,
  res: Response,
): Promise<boolean> {
  if (await canAccessStudio(staff, studioId)) return true;
  res.status(403).json({ error: "Kein Zugriff auf dieses Studio." });
  return false;
}

function dateIsValid(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function serializeClosure<T extends {
  fromDate: string;
  toDate: string;
}>(closure: T) {
  // Generated response schemas coerce format:date to Date; keep calendar dates
  // as date-only strings on the wire after validating the response shape.
  const parsed = CreateStudioRoomClosureResponse.parse(closure);
  return { ...parsed, fromDate: closure.fromDate, toDate: closure.toDate };
}

async function affectedCourses(studioId: number, roomName: string, fromDate: string, toDate: string) {
  const studioCourses = await db.select({
    id: coursesTable.id,
    title: coursesTable.title,
    instructor: coursesTable.instructor,
    studioId: coursesTable.studioId,
    studioName: studiosTable.name,
    startsAt: coursesTable.startsAt,
    endsAt: coursesTable.endsAt,
    capacity: coursesTable.capacity,
    enrolled: coursesTable.enrolled,
    room: coursesTable.room,
    status: coursesTable.status,
  }).from(coursesTable)
    .innerJoin(studiosTable, eq(studiosTable.id, coursesTable.studioId))
    .where(and(eq(coursesTable.studioId, studioId), eq(coursesTable.room, roomName), ne(coursesTable.status, "cancelled")));
  return studioCourses.filter((course) =>
    closureIntersectsInterval(fromDate, toDate, course.startsAt, course.endsAt),
  );
}

router.get("/studios/:studioId/rooms", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const params = ListStudioRoomsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!(await accessibleStudio(staff, params.data.studioId, res))) return;
  const rows = await db.select().from(roomsTable)
    .where(eq(roomsTable.studioId, params.data.studioId))
    .orderBy(asc(roomsTable.name));
  res.json(ListStudioRoomsResponse.parse(rows));
});

router.post("/studios/:studioId/rooms", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const params = CreateStudioRoomParams.safeParse(req.params);
  const body = CreateStudioRoomBody.safeParse(req.body);
  if (!params.success || !body.success || !body.data.name.trim()) {
    res.status(400).json({ error: !params.success ? params.error.message : !body.success ? body.error.message : "Der Raumname darf nicht leer sein." });
    return;
  }
  if (!(await accessibleStudio(staff, params.data.studioId, res))) return;
  try {
    const [room] = await db.insert(roomsTable).values({
      studioId: params.data.studioId,
      name: body.data.name.trim(),
    }).returning();
    res.status(201).json(CreateStudioRoomResponse.parse(room));
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") {
      res.status(409).json({ error: "Dieser Raum ist in diesem Studio bereits angelegt." });
      return;
    }
    throw error;
  }
});

router.get("/studios/:studioId/closures", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const params = ListStudioRoomClosuresParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!(await accessibleStudio(staff, params.data.studioId, res))) return;
  const rows = await db.select().from(roomClosuresTable)
    .where(eq(roomClosuresTable.studioId, params.data.studioId))
    .orderBy(asc(roomClosuresTable.fromDate), asc(roomClosuresTable.id));
  res.json(ListStudioRoomClosuresResponse.parse(rows.map((row) => ({
    ...row,
    fromDate: new Date(`${row.fromDate}T00:00:00.000Z`),
    toDate: new Date(`${row.toDate}T00:00:00.000Z`),
  }))).map((row, index) => ({
    ...row,
    fromDate: rows[index].fromDate,
    toDate: rows[index].toDate,
  })));
});

router.post("/studios/:studioId/closures", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const params = CreateStudioRoomClosureParams.safeParse(req.params);
  const body = CreateStudioRoomClosureBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.success ? "Ungültige Eingabe." : body.error.message });
    return;
  }
  if (!(await accessibleStudio(staff, params.data.studioId, res))) return;
  const closureInput = {
    ...body.data,
    roomName: body.data.roomName.trim(),
    fromDate: req.body.fromDate as string,
    toDate: req.body.toDate as string,
    reason: body.data.reason.trim(),
    responsible: body.data.responsible.trim(),
  };
  if (!closureInput.roomName || !closureInput.reason || !closureInput.responsible ||
      !dateIsValid(req.body.fromDate) || !dateIsValid(req.body.toDate) ||
      closureInput.toDate < closureInput.fromDate) {
    res.status(400).json({ error: "Bitte gib gültige Kalenderdaten und einen zusammenhängenden Zeitraum an." });
    return;
  }

  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fiudia-room:${params.data.studioId}:${closureInput.roomName}`}))`);
    const [room] = await tx.select({ id: roomsTable.id }).from(roomsTable).where(and(
      eq(roomsTable.studioId, params.data.studioId),
      eq(roomsTable.name, closureInput.roomName),
    )).limit(1);
    if (!room) return { error: "room_missing" as const };
    const [overlap] = await tx.select({ id: roomClosuresTable.id }).from(roomClosuresTable).where(and(
      eq(roomClosuresTable.studioId, params.data.studioId),
      eq(roomClosuresTable.roomName, closureInput.roomName),
      lte(roomClosuresTable.fromDate, closureInput.toDate),
      gte(roomClosuresTable.toDate, closureInput.fromDate),
    )).limit(1);
    if (overlap) return { error: "closure_overlap" as const };
    const [closure] = await tx.insert(roomClosuresTable).values({
      ...closureInput,
      studioId: params.data.studioId,
      createdByStaffId: staff.id,
    }).returning();
    const courseRows = await tx.select({
      startsAt: coursesTable.startsAt,
      endsAt: coursesTable.endsAt,
    }).from(coursesTable).where(and(
      eq(coursesTable.studioId, params.data.studioId),
      eq(coursesTable.room, closureInput.roomName),
      ne(coursesTable.status, "cancelled"),
    ));
    const impactedCount = courseRows.filter((course) =>
      closureIntersectsInterval(closureInput.fromDate, closureInput.toDate, course.startsAt, course.endsAt),
    ).length;
    const [studio] = await tx.select({ organizationId: studiosTable.organizationId })
      .from(studiosTable).where(eq(studiosTable.id, params.data.studioId)).limit(1);
    await tx.insert(pulseMessagesTable).values({
      organizationId: studio.organizationId,
      studioId: params.data.studioId,
      roomClosureId: closure.id,
      authorStaffId: staff.id,
      title: `Raumschließung: ${closureInput.roomName}`,
      body: `${closureInput.roomName} ist vom ${closureInput.fromDate} bis einschließlich ${closureInput.toDate} geschlossen (${closureInput.reason}). ${impactedCount} nicht stornierte Kurse betroffen. Bitte betroffene Kurse in Fiudia prüfen und in einen freien Raum verlegen oder stornieren.`,
      priority: "important",
      audience: "managers",
    });
    return { closure };
  });
  if ("error" in created) {
    if (created.error === "room_missing") {
      res.status(404).json({ error: "Der angegebene Raum ist in diesem Studio nicht angelegt." });
      return;
    }
    res.status(409).json({ error: "Für diesen Raum besteht bereits eine zeitlich überlappende Schließung." });
    return;
  }
  res.status(201).json(serializeClosure(created.closure));
});

router.delete("/studios/:studioId/closures/:closureId", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const params = DeleteStudioRoomClosureParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!(await accessibleStudio(staff, params.data.studioId, res))) return;
  const result = await db.transaction(async (tx) => {
    const [closure] = await tx.select({ id: roomClosuresTable.id }).from(roomClosuresTable).where(and(
      eq(roomClosuresTable.id, params.data.closureId),
      eq(roomClosuresTable.studioId, params.data.studioId),
    )).limit(1).for("update");
    if (!closure) return "missing" as const;
    const [resolution] = await tx.select({ id: courseClosureResolutionsTable.id })
      .from(courseClosureResolutionsTable)
      .where(eq(courseClosureResolutionsTable.closureId, closure.id))
      .limit(1);
    if (resolution) return "resolved" as const;
    await tx.delete(roomClosuresTable).where(eq(roomClosuresTable.id, closure.id));
    return "deleted" as const;
  });
  if (result === "missing") {
    res.status(404).json({ error: "Raumschließung nicht gefunden." });
    return;
  }
  if (result === "resolved") {
    res.status(409).json({ error: "Diese Schließung hat bereits Kursauflösungen oder Benachrichtigungen und kann nicht gelöscht werden." });
    return;
  }
  res.sendStatus(204);
});

router.get("/studios/:studioId/closures/:closureId/courses", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const params = ListClosureAffectedCoursesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!(await accessibleStudio(staff, params.data.studioId, res))) return;
  const [closure] = await db.select().from(roomClosuresTable).where(and(
    eq(roomClosuresTable.id, params.data.closureId),
    eq(roomClosuresTable.studioId, params.data.studioId),
  )).limit(1);
  if (!closure) {
    res.status(404).json({ error: "Raumschließung nicht gefunden." });
    return;
  }
  const courses = await affectedCourses(closure.studioId, closure.roomName, closure.fromDate, closure.toDate);
  const assets = await db.select({ name: roomsTable.name }).from(roomsTable)
    .where(eq(roomsTable.studioId, closure.studioId));
  const studioCourses = await db.select({
    room: coursesTable.room,
    startsAt: coursesTable.startsAt,
    endsAt: coursesTable.endsAt,
    status: coursesTable.status,
  }).from(coursesTable).where(and(
    eq(coursesTable.studioId, closure.studioId),
    ne(coursesTable.status, "cancelled"),
  ));
  const otherClosures = await db.select({
    roomName: roomClosuresTable.roomName,
    fromDate: roomClosuresTable.fromDate,
    toDate: roomClosuresTable.toDate,
  }).from(roomClosuresTable).where(eq(roomClosuresTable.studioId, closure.studioId));
  const resolutions = courses.length
    ? await db.select({ courseId: courseClosureResolutionsTable.courseId })
      .from(courseClosureResolutionsTable)
      .where(and(
        inArray(courseClosureResolutionsTable.courseId, courses.map((course) => course.id)),
        eq(courseClosureResolutionsTable.closureId, closure.id),
      ))
    : [];
  const resolvedIds = new Set(resolutions.map((resolution) => resolution.courseId));
  const result = courses.map((course) => ({
    ...course,
    startsAt: course.startsAt.toISOString(),
    endsAt: course.endsAt.toISOString(),
    alternativeRooms: assets.map(({ name }) => name).filter((name) =>
      name !== course.room &&
      !studioCourses.some((other) => other.room === name &&
        other.startsAt < course.endsAt && other.endsAt > course.startsAt) &&
      !otherClosures.some((other) => other.roomName === name &&
        closureIntersectsInterval(other.fromDate, other.toDate, course.startsAt, course.endsAt)),
    ),
    resolved: resolvedIds.has(course.id),
  }));
  res.json(ListClosureAffectedCoursesResponse.parse(result));
});

router.get("/studios/:studioId/closures/:closureId/resolutions", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const params = ListClosureResolutionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!(await accessibleStudio(staff, params.data.studioId, res))) return;
  const [closure] = await db.select({ id: roomClosuresTable.id })
    .from(roomClosuresTable).where(and(
      eq(roomClosuresTable.id, params.data.closureId),
      eq(roomClosuresTable.studioId, params.data.studioId),
    )).limit(1);
  if (!closure) {
    res.status(404).json({ error: "Raumschließung nicht gefunden." });
    return;
  }
  const rows = await listClosureResolutionsForStudio(params.data.studioId, closure.id);
  res.json(ListClosureResolutionsResponse.parse(rows));
});

router.get("/studios/:studioId/closures/push-readiness", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const params = GetClosurePushReadinessParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!(await accessibleStudio(staff, params.data.studioId, res))) return;
  res.setHeader("Cache-Control", "no-store");
  const reason = await closurePushReadiness();
  res.json(GetClosurePushReadinessResponse.parse({ ready: reason === null, reason }));
});

function resolutionMessage(action: "relocate" | "cancel", courseTitle: string, room: string | null) {
  return action === "relocate"
    ? `Der Kurs „${courseTitle}“ findet wegen einer Raumschließung nun in ${room} statt.`
    : `Der Kurs „${courseTitle}“ wurde wegen einer Raumschließung abgesagt.`;
}

router.post("/courses/:id/closure-resolution", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const params = ResolveCourseRoomClosureParams.safeParse(req.params);
  const body = ResolveCourseRoomClosureBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.success ? "Ungültige Eingabe." : body.error.message });
    return;
  }
  const request = body.data;
  // Unsupported channels must fail before any course, booking, or notification mutation.
  if (request.channel === "whatsapp") {
    res.status(409).json({ error: "Der Benachrichtigungskanal whatsapp wird nicht unterstützt; es wurde nichts geändert oder versendet." });
    return;
  }
  if (request.action === "relocate" && !request.room?.trim()) {
    res.status(400).json({ error: "Für eine Verlegung muss ein Zielraum angegeben werden." });
    return;
  }

  const [course] = await db.select().from(coursesTable).where(eq(coursesTable.id, params.data.id)).limit(1);
  if (!course) {
    res.status(404).json({ error: "Kurs nicht gefunden." });
    return;
  }
  if (!(await accessibleStudio(staff, course.studioId, res))) return;

  if (request.channel === "email" || request.channel === "push") {
    // An idempotent replay of a completed resolution must still be readable
    // if the provider becomes unavailable after the first attempt.
    const [prior] = await db.select({ id: courseClosureResolutionsTable.id })
      .from(courseClosureResolutionsTable)
      .where(and(
        eq(courseClosureResolutionsTable.courseId, course.id),
        eq(courseClosureResolutionsTable.closureId, request.closureId),
      )).limit(1);
    if (!prior) {
      const issue = request.channel === "email"
        ? await closureEmailReadiness()
        : await closurePushReadiness();
      if (issue) {
        res.status(409).json({ error: issue });
        return;
      }
    }
  }

  const result = await db.transaction(async (tx) => {
    const [lockedCourse] = await tx.select().from(coursesTable)
      .where(eq(coursesTable.id, course.id)).limit(1).for("update");
    if (!lockedCourse) {
      return { error: "Der Kurs ist nicht mehr für eine Raumschließung verfügbar." as const };
    }
    const [existing] = await tx.select().from(courseClosureResolutionsTable)
      .where(and(
        eq(courseClosureResolutionsTable.courseId, lockedCourse.id),
        eq(courseClosureResolutionsTable.closureId, request.closureId),
      )).limit(1);
    if (existing) {
      if (!resolutionRetryMatches(existing, request)) {
        return { error: "Dieser Kurs wurde bereits aufgelöst; ein abweichender erneuter Versuch ist nicht möglich." as const };
      }
      return { existing };
    }
    const [usedKey] = await tx.select({ courseId: courseClosureResolutionsTable.courseId })
      .from(courseClosureResolutionsTable)
      .where(eq(courseClosureResolutionsTable.idempotencyKey, request.idempotencyKey))
      .limit(1);
    if (usedKey) {
      return { error: "Dieser Idempotenzschlüssel wurde bereits für einen anderen Kurs verwendet." as const };
    }
    if (lockedCourse.status === "cancelled") {
      return { error: "Der Kurs ist nicht mehr für eine Raumschließung verfügbar." as const };
    }
    const [closure] = await tx.select().from(roomClosuresTable).where(and(
      eq(roomClosuresTable.id, request.closureId),
      eq(roomClosuresTable.studioId, lockedCourse.studioId),
      eq(roomClosuresTable.roomName, lockedCourse.room),
    )).limit(1).for("update");
    if (!closure || !closureIntersectsInterval(closure.fromDate, closure.toDate, lockedCourse.startsAt, lockedCourse.endsAt)) {
      return { error: "Die angegebene Raumschließung betrifft diesen Kurs nicht mehr." as const };
    }

    if (request.action === "relocate") {
      const target = request.room!.trim();
      const [room] = await tx.select({ name: roomsTable.name }).from(roomsTable).where(and(
        eq(roomsTable.studioId, lockedCourse.studioId),
        eq(roomsTable.name, target),
      )).limit(1);
      if (!room || target === lockedCourse.room) {
        return { error: "Der Zielraum muss ein anderer, angelegter Raum desselben Studios sein." as const };
      }
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fiudia-room:${lockedCourse.studioId}:${target}`}))`);
      const allRooms = await tx.select().from(roomClosuresTable).where(and(
        eq(roomClosuresTable.studioId, lockedCourse.studioId),
        eq(roomClosuresTable.roomName, target),
      ));
      if (allRooms.some((blocked) =>
        closureIntersectsInterval(blocked.fromDate, blocked.toDate, lockedCourse.startsAt, lockedCourse.endsAt),
      )) {
        return { error: "Der Zielraum ist während des gesamten Kursintervalls geschlossen." as const };
      }
      if (await hasOverlappingLiveCourse(
        lockedCourse.studioId,
        target,
        lockedCourse.startsAt,
        lockedCourse.endsAt,
        tx,
        lockedCourse.id,
      )) {
        return { error: "Im Zielraum liegt ein anderer geplanter oder ausgebuchter Kurs." as const };
      }
    }

    const activeBookings = await tx.select({
      id: courseBookingsTable.id,
      memberId: courseBookingsTable.memberId,
      memberEmail: membersTable.email,
    }).from(courseBookingsTable)
      .innerJoin(membersTable, eq(membersTable.id, courseBookingsTable.memberId))
      .where(and(
        eq(courseBookingsTable.courseId, lockedCourse.id),
        inArray(courseBookingsTable.status, ["confirmed", "waitlisted"]),
        eq(membersTable.studioId, lockedCourse.studioId),
      ));
    let pushTargets: ReturnType<typeof buildClosurePushDeliveryTargets> = [];
    if (request.channel === "push" && activeBookings.length) {
      const subscriptions = await tx.select({
        memberId: memberPushSubscriptionsTable.memberId,
        subscriptionId: memberPushSubscriptionsTable.subscriptionId,
      }).from(memberPushSubscriptionsTable).where(inArray(
        memberPushSubscriptionsTable.memberId,
        activeBookings.map(({ memberId }) => memberId),
      ));
      pushTargets = buildClosurePushDeliveryTargets(activeBookings, subscriptions);
      if (!pushTargets.some(({ subscriptionId }) => subscriptionId !== null)) {
        return { error: "Für diesen Kurs ist kein Browser-Push-Abonnement eingerichtet. Bitte wählen Sie In-App, damit alle gebuchten Mitglieder die Kursänderung erhalten." as const };
      }
    }
    const title = request.action === "cancel"
      ? "Dein Kurs wurde storniert"
      : "Der Kursraum wurde geändert";
    const messageBody = resolutionMessage(request.action, lockedCourse.title, request.action === "relocate" ? request.room!.trim() : null);
    const [resolution] = await tx.insert(courseClosureResolutionsTable).values({
      courseId: lockedCourse.id,
      closureId: closure.id,
      action: request.action,
      targetRoom: request.action === "relocate" ? request.room!.trim() : null,
      channel: request.channel,
      idempotencyKey: request.idempotencyKey,
    }).returning();

    if (request.action === "relocate") {
      await tx.update(coursesTable).set({ room: request.room!.trim() })
        .where(eq(coursesTable.id, lockedCourse.id));
    } else {
      await invalidateCoursePromotionNotices(lockedCourse.id, lockedCourse.title, tx);
      await tx.update(coursesTable).set({ status: "cancelled", enrolled: 0 })
        .where(eq(coursesTable.id, lockedCourse.id));
      await tx.update(courseBookingsTable).set({ status: "cancelled" }).where(and(
        eq(courseBookingsTable.courseId, lockedCourse.id),
        inArray(courseBookingsTable.status, ["confirmed", "waitlisted"]),
      ));
      await settleCancelledTrainerCourse(lockedCourse.id, staff.id, tx);
    }

    if (request.channel === "in_app" || request.channel === "push") {
      if (activeBookings.length) {
        await tx.insert(memberNotificationsTable).values(activeBookings.map((booking) => ({
          bookingId: booking.id,
          memberId: booking.memberId,
          courseId: lockedCourse.id,
          title,
          body: messageBody,
        })));
      }
    } else if (activeBookings.length) {
      await tx.insert(closureEmailDeliveriesTable).values(activeBookings.map((booking) => ({
        resolutionId: resolution.id,
        bookingId: booking.id,
        memberId: booking.memberId,
        email: booking.memberEmail,
      })));
    }
    if (request.channel === "push" && pushTargets.length) {
      await tx.insert(closurePushDeliveriesTable).values(pushTargets.map((target) => ({
        resolutionId: resolution.id,
        bookingId: target.bookingId,
        memberId: target.memberId,
        subscriptionId: target.subscriptionId,
        idempotencyKey: randomUUID(),
        status: target.status,
        error: target.error,
      })));
    }
    return {
      resolution,
      recipients: activeBookings,
      courseTitle: lockedCourse.title,
      notification: { title, body: messageBody },
    };
  });

  if ("error" in result) {
    res.status(409).json({ error: result.error });
    return;
  }

  const chosenChannel = result.existing?.channel ?? result.resolution?.channel ?? request.channel;
  if (result.existing && result.existing.channel !== request.channel) {
    res.status(409).json({ error: "Der Wiederholungsversuch muss denselben Benachrichtigungskanal verwenden." });
    return;
  }
  const resolution = result.existing ?? result.resolution!;
  const action = resolution.action as "relocate" | "cancel";
  const room = resolution.targetRoom;
  let notifications: Array<{ memberId: number; channel: "in_app" | "email" | "push"; status: "created" | "sent" | "failed" | "pending" | "sending" | "skipped"; detail: string | null }> = [];
  if (chosenChannel === "in_app") {
    const people = result.existing
      ? await db.select({ memberId: memberNotificationsTable.memberId })
        .from(memberNotificationsTable).where(and(
          eq(memberNotificationsTable.courseId, course.id),
          eq(memberNotificationsTable.title, action === "cancel" ? "Dein Kurs wurde storniert" : "Der Kursraum wurde geändert"),
        ))
      : result.recipients.map(({ memberId }) => ({ memberId }));
    notifications = people.map(({ memberId }) => ({
      memberId,
      channel: "in_app",
      status: "created",
      detail: null,
    }));
  } else if (chosenChannel === "email") {
    const deliveries = await processResolutionEmails(resolution.id);
    notifications = deliveries.map((delivery) => ({
      memberId: delivery.memberId,
      channel: "email" as const,
      status: delivery.status as "created" | "sent" | "failed" | "pending" | "sending",
      detail: delivery.error,
    }));
  } else {
    const deliveries = await processResolutionPushDeliveries(resolution.id);
    notifications = deliveries.map((delivery) => ({
      memberId: delivery.memberId,
      channel: "push" as const,
      status: delivery.status as "created" | "sent" | "failed" | "pending" | "sending" | "skipped",
      detail: delivery.error,
    }));
  }
  const response = {
    resolutionId: resolution.id,
    courseId: course.id,
    action,
    room,
    channel: chosenChannel,
    notifications,
  };
  res.json(ResolveCourseRoomClosureResponse.parse(response));
});

async function accessibleResolution(
  resolutionId: number,
  staff: StaffContext,
  res: Response,
) {
  const [resolution] = await db.select({
    id: courseClosureResolutionsTable.id,
    studioId: coursesTable.studioId,
    channel: courseClosureResolutionsTable.channel,
  }).from(courseClosureResolutionsTable)
    .innerJoin(coursesTable, eq(coursesTable.id, courseClosureResolutionsTable.courseId))
    .innerJoin(roomClosuresTable, eq(roomClosuresTable.id, courseClosureResolutionsTable.closureId))
    .where(and(
      eq(courseClosureResolutionsTable.id, resolutionId),
      eq(roomClosuresTable.studioId, coursesTable.studioId),
    ))
    .limit(1);
  if (!resolution) {
    res.status(404).json({ error: "Kursauflösung nicht gefunden." });
    return null;
  }
  if (!(await accessibleStudio(staff, resolution.studioId, res))) return null;
  return resolution;
}

router.get("/closure-resolutions/:resolutionId/email-deliveries", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const params = GetClosureEmailDeliveriesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const resolutionId = params.data.resolutionId;
  if (!(await accessibleResolution(resolutionId, staff, res))) return;
  const deliveries = await getResolutionEmailStatuses(resolutionId);
  res.json(GetClosureEmailDeliveriesResponse.parse({
    resolutionId,
    deliveries,
  }));
});

router.post("/closure-resolutions/:resolutionId/email-deliveries", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const params = RetryClosureEmailDeliveriesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const resolutionId = params.data.resolutionId;
  if (!(await accessibleResolution(resolutionId, staff, res))) return;
  const deliveries = await processResolutionEmails(resolutionId);
  res.json(RetryClosureEmailDeliveriesResponse.parse({
    resolutionId,
    deliveries,
  }));
});

router.get("/closure-resolutions/:resolutionId/push-deliveries", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const params = GetClosurePushDeliveriesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const resolution = await accessibleResolution(params.data.resolutionId, staff, res);
  if (!resolution) return;
  if (resolution.channel !== "push") {
    res.status(409).json({ error: "Diese Kursauflösung verwendet keinen Push-Kanal." });
    return;
  }
  const deliveries = await getResolutionPushStatuses(params.data.resolutionId);
  res.json(GetClosurePushDeliveriesResponse.parse({
    resolutionId: params.data.resolutionId,
    deliveries,
  }));
});

router.post("/closure-resolutions/:resolutionId/push-deliveries", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const params = RetryClosurePushDeliveriesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const resolution = await accessibleResolution(params.data.resolutionId, staff, res);
  if (!resolution) return;
  if (resolution.channel !== "push") {
    res.status(409).json({ error: "Diese Kursauflösung verwendet keinen Push-Kanal." });
    return;
  }
  const deliveries = await processResolutionPushDeliveries(params.data.resolutionId);
  res.json(RetryClosurePushDeliveriesResponse.parse({
    resolutionId: params.data.resolutionId,
    deliveries,
  }));
});

export default router;