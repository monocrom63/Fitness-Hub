import { and, asc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CancelStaffCourseBookingParams,
  CancelStaffCourseBookingBody,
  CancelStaffCourseBookingResponse,
  CreateStaffCourseBookingBody,
  CreateStaffCourseBookingParams,
  CreateStaffCourseBookingResponse,
  ListCourseBookingsParams,
  ListCourseBookingsResponse,
} from "@workspace/api-zod";
import { courseBookingsTable, coursesTable, db, membersTable } from "@workspace/db";
import { BookingError, bookCourse, cancelCourseBooking } from "../lib/course-bookings";
import { canAccessStudio, canManageCourses, getRequestUserId, getStaffContext } from "../lib/fiudia-access";

const router: IRouter = Router();

router.get("/courses/:id/bookings", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const staff = await getStaffContext(userId);
  if (!staff) { res.status(403).json({ error: "Kein Teamzugang." }); return; }
  if (!canManageCourses(staff)) {
    res.status(403).json({ error: "Nur Studio-Manager dürfen Kursbuchungen einsehen." });
    return;
  }
  const params = ListCourseBookingsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Ungültiger Kurs." }); return;
  }
  const [course] = await db.select({ studioId: coursesTable.studioId })
    .from(coursesTable).where(eq(coursesTable.id, params.data.id)).limit(1);
  if (!course || !(await canAccessStudio(staff, course.studioId))) {
    res.status(404).json({ error: "Kurs nicht gefunden." }); return;
  }

  const bookings = await db.select({
    id: courseBookingsTable.id,
    courseId: courseBookingsTable.courseId,
    memberId: courseBookingsTable.memberId,
    memberName: membersTable.fullName,
    status: courseBookingsTable.status,
    createdAt: courseBookingsTable.createdAt,
  }).from(courseBookingsTable)
    .innerJoin(membersTable, eq(courseBookingsTable.memberId, membersTable.id))
    .where(and(
      eq(courseBookingsTable.courseId, params.data.id),
      eq(membersTable.studioId, course.studioId),
    ))
    .orderBy(asc(courseBookingsTable.createdAt), asc(courseBookingsTable.id));

  let waitlistPosition = 0;
  const roster = bookings
    .filter((booking) => booking.status === "confirmed" || booking.status === "waitlisted")
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "confirmed" ? -1 : 1;
      return a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id;
    })
    .map((booking) => ({
      id: booking.id,
      courseId: booking.courseId,
      memberId: booking.memberId,
      memberName: booking.memberName,
      status: booking.status as "confirmed" | "waitlisted",
      waitlistPosition: booking.status === "waitlisted" ? ++waitlistPosition : null,
      createdAt: booking.createdAt,
    }));
  res.json(ListCourseBookingsResponse.parse(roster));
});

router.post("/courses/:id/bookings", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const staff = await getStaffContext(userId);
  if (!staff) { res.status(403).json({ error: "Kein Teamzugang." }); return; }
  if (!canManageCourses(staff)) {
    res.status(403).json({ error: "Nur Studio-Manager dürfen Kursbuchungen verwalten." });
    return;
  }
  const params = CreateStaffCourseBookingParams.safeParse(req.params);
  const body = CreateStaffCourseBookingBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Ungültige Kursbuchung." }); return;
  }
  const [course] = await db.select({ studioId: coursesTable.studioId })
    .from(coursesTable).where(eq(coursesTable.id, params.data.id)).limit(1);
  if (!course || !(await canAccessStudio(staff, course.studioId))) {
    res.status(404).json({ error: "Kurs nicht gefunden." }); return;
  }
  try {
    const booking = await bookCourse(params.data.id, body.data.memberId);
    res.status(201).json(CreateStaffCourseBookingResponse.parse(booking));
  } catch (error) {
    if (error instanceof BookingError) {
      res.status(error.status).json({ error: error.message }); return;
    }
    throw error;
  }
});

router.delete("/courses/:id/bookings/:memberId", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const staff = await getStaffContext(userId);
  if (!staff) { res.status(403).json({ error: "Kein Teamzugang." }); return; }
  if (!canManageCourses(staff)) {
    res.status(403).json({ error: "Nur Studio-Manager dürfen Kursbuchungen stornieren." });
    return;
  }
  const params = CancelStaffCourseBookingParams.safeParse(req.params);
  const body = CancelStaffCourseBookingBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Ungültige Kursbuchung." }); return;
  }
  const [course] = await db.select({ studioId: coursesTable.studioId })
    .from(coursesTable).where(eq(coursesTable.id, params.data.id)).limit(1);
  if (!course || !(await canAccessStudio(staff, course.studioId))) {
    res.status(404).json({ error: "Kurs nicht gefunden." }); return;
  }
  const [booking] = await db.select({ id: courseBookingsTable.id })
    .from(courseBookingsTable)
    .innerJoin(membersTable, eq(courseBookingsTable.memberId, membersTable.id))
    .where(and(
      eq(courseBookingsTable.courseId, params.data.id),
      eq(courseBookingsTable.memberId, params.data.memberId),
      eq(membersTable.studioId, course.studioId),
      inArray(courseBookingsTable.status, ["confirmed", "waitlisted"]),
    ))
    .limit(1);
  if (!booking) {
    res.status(404).json({ error: "Aktive Buchung nicht gefunden." }); return;
  }
  try {
    const result = await cancelCourseBooking(params.data.id, params.data.memberId, db, {
      expectedStatus: body.data.expectedStatus,
      cancelledByStaff: true,
    });
    res.json(CancelStaffCourseBookingResponse.parse(result));
  } catch (error) {
    if (error instanceof BookingError) {
      res.status(error.status).json({ error: error.message }); return;
    }
    throw error;
  }
});

export default router;