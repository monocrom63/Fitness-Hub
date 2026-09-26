import { eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateStaffCourseBookingBody,
  CreateStaffCourseBookingParams,
  CreateStaffCourseBookingResponse,
} from "@workspace/api-zod";
import { coursesTable, db } from "@workspace/db";
import { BookingError, bookCourse } from "../lib/course-bookings";
import { canAccessStudio, getRequestUserId, getStaffContext } from "../lib/fiudia-access";

const router: IRouter = Router();

router.post("/courses/:id/bookings", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const staff = await getStaffContext(userId);
  if (!staff) { res.status(403).json({ error: "Kein Teamzugang." }); return; }
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

export default router;