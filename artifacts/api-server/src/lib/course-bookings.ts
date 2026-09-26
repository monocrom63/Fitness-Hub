import { and, asc, count, eq } from "drizzle-orm";
import { courseBookingsTable, coursesTable, db, memberNotificationsTable, membersTable } from "@workspace/db";

export class BookingError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function courseDateTime(date: Date) {
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export async function bookCourse(
  courseId: number,
  memberId: number,
  database: typeof db = db,
) {
  return database.transaction(async (tx) => {
    const [course] = await tx.select().from(coursesTable)
      .where(eq(coursesTable.id, courseId)).limit(1).for("update");
    if (!course) throw new BookingError(404, "Kurs nicht gefunden.");
    if (course.status === "cancelled" || course.startsAt <= new Date()) {
      throw new BookingError(409, "Dieser Kurs kann nicht mehr gebucht werden.");
    }
    const [member] = await tx.select({ id: membersTable.id })
      .from(membersTable)
      .where(and(
        eq(membersTable.id, memberId),
        eq(membersTable.studioId, course.studioId),
        eq(membersTable.status, "active"),
      )).limit(1);
    if (!member) throw new BookingError(404, "Aktives Mitglied in diesem Studio nicht gefunden.");

    const [existing] = await tx.select().from(courseBookingsTable)
      .where(and(
        eq(courseBookingsTable.courseId, courseId),
        eq(courseBookingsTable.memberId, memberId),
      )).limit(1);
    if (existing && existing.status !== "cancelled") {
      throw new BookingError(409, "Für dieses Mitglied besteht bereits eine Buchung.");
    }

    const status = course.enrolled < course.capacity ? "confirmed" : "waitlisted";
    const [queue] = status === "waitlisted"
      ? await tx.select({ total: count() }).from(courseBookingsTable)
        .where(and(eq(courseBookingsTable.courseId, courseId), eq(courseBookingsTable.status, "waitlisted")))
      : [{ total: 0 }];
    const [booking] = existing
      ? await tx.update(courseBookingsTable)
        .set({ status, createdAt: new Date() })
        .where(eq(courseBookingsTable.id, existing.id)).returning()
      : await tx.insert(courseBookingsTable)
        .values({ courseId, memberId, status }).returning();

    if (status === "confirmed") {
      const enrolled = course.enrolled + 1;
      await tx.update(coursesTable)
        .set({ enrolled, status: enrolled >= course.capacity ? "full" : "scheduled" })
        .where(eq(coursesTable.id, courseId));
    }
    return {
      id: booking.id, courseId, memberId, status,
      waitlistPosition: status === "waitlisted" ? queue.total + 1 : null,
    };
  });
}

export async function cancelCourseBooking(
  courseId: number,
  memberId: number,
  database: typeof db = db,
  options: { expectedStatus?: "confirmed" | "waitlisted"; cancelledByStaff?: boolean } = {},
) {
  return database.transaction(async (tx) => {
    const [course] = await tx.select().from(coursesTable)
      .where(eq(coursesTable.id, courseId)).limit(1).for("update");
    if (!course) throw new BookingError(404, "Buchung nicht gefunden.");
    if (course.startsAt <= new Date()) {
      throw new BookingError(409, "Ein vergangener Kurs kann nicht storniert werden.");
    }
    const [booking] = await tx.select().from(courseBookingsTable)
      .where(and(
        eq(courseBookingsTable.courseId, courseId),
        eq(courseBookingsTable.memberId, memberId),
      )).limit(1);
    if (!booking || booking.status === "cancelled") {
      if (booking && options.expectedStatus) {
        throw new BookingError(409, "Der Buchungsstatus hat sich geändert. Bitte lade die Teilnehmerliste neu.");
      }
      throw new BookingError(404, "Aktive Buchung nicht gefunden.");
    }
    if (options.expectedStatus && booking.status !== options.expectedStatus) {
      throw new BookingError(409, "Der Buchungsstatus hat sich geändert. Bitte lade die Teilnehmerliste neu.");
    }

    await tx.update(courseBookingsTable).set({ status: "cancelled" })
      .where(eq(courseBookingsTable.id, booking.id));
    await tx.update(memberNotificationsTable)
      .set({
        title: "Diese Platzbestätigung ist nicht mehr gültig",
        body: `Deine frühere Platzbestätigung für „${course.title}“ gilt nicht mehr. Sieh dir deinen aktuellen Kursplan an.`,
        readAt: options.cancelledByStaff ? null : new Date(),
      })
      .where(and(
        eq(memberNotificationsTable.bookingId, booking.id),
        eq(memberNotificationsTable.title, "Dein Kursplatz ist bestätigt"),
      ));
    if (options.cancelledByStaff) {
      await tx.insert(memberNotificationsTable).values({
        bookingId: booking.id,
        memberId,
        courseId,
        title: "Deine Kursbuchung wurde storniert",
        body: `Dein Studio hat deine ${booking.status === "waitlisted" ? "Wartelistenposition" : "Buchung"} für „${course.title}“ storniert.`,
      });
    }
    if (booking.status === "confirmed") {
      const queue = course.status === "cancelled" ? [] : await tx.select({
        id: courseBookingsTable.id,
        memberId: courseBookingsTable.memberId,
        memberStatus: membersTable.status,
        memberStudioId: membersTable.studioId,
      }).from(courseBookingsTable)
        .innerJoin(membersTable, eq(courseBookingsTable.memberId, membersTable.id))
        .where(and(
          eq(courseBookingsTable.courseId, courseId),
          eq(courseBookingsTable.status, "waitlisted"),
        ))
        .orderBy(asc(courseBookingsTable.createdAt), asc(courseBookingsTable.id))
        .for("update");
      let promoted = false;
      for (const candidate of queue) {
        if (candidate.memberStatus !== "active" || candidate.memberStudioId !== course.studioId) {
          await tx.update(courseBookingsTable).set({ status: "cancelled" })
            .where(eq(courseBookingsTable.id, candidate.id));
          continue;
        }
        await tx.update(courseBookingsTable).set({ status: "confirmed" })
          .where(eq(courseBookingsTable.id, candidate.id));
        await tx.insert(memberNotificationsTable).values({
          bookingId: candidate.id,
          memberId: candidate.memberId,
          courseId,
          title: "Dein Kursplatz ist bestätigt",
          body: `Du bist für „${course.title}“ am ${courseDateTime(course.startsAt)} Uhr von der Warteliste nachgerückt. Deinen Platz findest du unter „Meine Plätze“.`,
        });
        promoted = true;
        break;
      }
      const enrolled = Math.max(0, course.enrolled - (promoted ? 0 : 1));
      if (course.status === "cancelled") {
        await tx.update(courseBookingsTable).set({ status: "cancelled" })
          .where(and(
            eq(courseBookingsTable.courseId, courseId),
            eq(courseBookingsTable.status, "waitlisted"),
          ));
      }
      await tx.update(coursesTable)
        .set({
          enrolled,
          status: course.status === "cancelled"
            ? "cancelled" : enrolled >= course.capacity ? "full" : "scheduled",
        })
        .where(eq(coursesTable.id, courseId));
    }
    return {
      id: booking.id, courseId, memberId, status: "cancelled",
      waitlistPosition: null,
    };
  });
}