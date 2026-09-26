import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import {
  courseBookingsTable, coursesTable, db, memberNotificationsTable, membersTable,
  organizationsTable, pool, studiosTable,
} from "@workspace/db";
import { bookCourse, cancelCourseBooking, BookingError } from "../src/lib/course-bookings";

const rollback = Symbol("rollback test fixture");

test("capacity, duplicate prevention, waitlist promotion and studio isolation", async () => {
  try {
    await db.transaction(async (tx) => {
      const suffix = randomUUID();
      const [org] = await tx.insert(organizationsTable)
        .values({ name: `Bookings ${suffix}` }).returning();
      const [studio, otherStudio] = await tx.insert(studiosTable).values([
        { organizationId: org.id, name: "Teststudio", city: "Berlin" },
        { organizationId: org.id, name: "Fremdstudio", city: "Berlin" },
      ]).returning();
      const [first, second, third, elsewhere] = await tx.insert(membersTable).values([
        { studioId: studio.id, fullName: "First", email: `first-${suffix}@example.invalid`, membershipType: "Basic" },
        { studioId: studio.id, fullName: "Second", email: `second-${suffix}@example.invalid`, membershipType: "Basic" },
        { studioId: studio.id, fullName: "Third", email: `third-${suffix}@example.invalid`, membershipType: "Basic" },
        { studioId: otherStudio.id, fullName: "Elsewhere", email: `else-${suffix}@example.invalid`, membershipType: "Basic" },
      ]).returning();
      const [course] = await tx.insert(coursesTable).values({
        studioId: studio.id, title: "Test", instructor: "Trainer",
        startsAt: new Date(Date.now() + 86400000),
        endsAt: new Date(Date.now() + 90000000),
        capacity: 1, room: "A",
      }).returning();
      const database = tx as unknown as typeof db;

      const booked = await bookCourse(course.id, first.id, database);
      assert.equal(booked.status, "confirmed");
      const waiting = await bookCourse(course.id, second.id, database);
      assert.equal(waiting.status, "waitlisted");
      assert.equal(waiting.waitlistPosition, 1);
      const eligibleWaiting = await bookCourse(course.id, third.id, database);
      assert.equal(eligibleWaiting.waitlistPosition, 2);
      await assert.rejects(bookCourse(course.id, second.id, database),
        (error) => error instanceof BookingError && error.status === 409);
      await assert.rejects(bookCourse(course.id, elsewhere.id, database),
        (error) => error instanceof BookingError && error.status === 404);

      await tx.update(membersTable).set({ status: "paused" })
        .where(eq(membersTable.id, second.id));
      await cancelCourseBooking(course.id, first.id, database);
      const [skipped] = await tx.select().from(courseBookingsTable)
        .where(eq(courseBookingsTable.id, waiting.id));
      assert.equal(skipped.status, "cancelled");
      const [promoted] = await tx.select().from(courseBookingsTable)
        .where(eq(courseBookingsTable.id, eligibleWaiting.id));
      assert.equal(promoted.status, "confirmed");
      const firstNotifications = await tx.select().from(memberNotificationsTable)
        .where(eq(memberNotificationsTable.memberId, third.id));
      assert.equal(firstNotifications.length, 1);
      assert.equal(firstNotifications[0].bookingId, eligibleWaiting.id);
      await assert.rejects(
        cancelCourseBooking(course.id, third.id, database, { expectedStatus: "waitlisted" }),
        (error) => error instanceof BookingError && error.status === 409,
      );
      const skippedNotifications = await tx.select().from(memberNotificationsTable)
        .where(eq(memberNotificationsTable.memberId, second.id));
      assert.equal(skippedNotifications.length, 0);
      const [full] = await tx.select().from(coursesTable).where(eq(coursesTable.id, course.id));
      assert.equal(full.enrolled, 1);
      await cancelCourseBooking(course.id, third.id, database);
      const [open] = await tx.select().from(coursesTable).where(eq(coursesTable.id, course.id));
      assert.equal(open.enrolled, 0);
      assert.equal(open.status, "scheduled");
      await bookCourse(course.id, first.id, database);
      await bookCourse(course.id, third.id, database);
      await cancelCourseBooking(course.id, first.id, database);
      const secondNotifications = await tx.select().from(memberNotificationsTable)
        .where(eq(memberNotificationsTable.memberId, third.id));
      assert.equal(secondNotifications.length, 2, "a later, separate promotion is a new notification");
      await bookCourse(course.id, first.id, database);
      await tx.update(coursesTable).set({ status: "cancelled" })
        .where(eq(coursesTable.id, course.id));
      await cancelCourseBooking(course.id, third.id, database);
      const [notPromoted] = await tx.select().from(courseBookingsTable)
        .where(eq(courseBookingsTable.id, booked.id));
      assert.equal(notPromoted.status, "cancelled");
      const staleNotifications = await tx.select().from(memberNotificationsTable)
        .where(eq(memberNotificationsTable.memberId, third.id));
      assert.equal(staleNotifications.some(item => item.title === "Dein Kursplatz ist bestätigt"), false);
      const falseNotifications = await tx.select().from(memberNotificationsTable)
        .where(eq(memberNotificationsTable.memberId, first.id));
      assert.equal(falseNotifications.length, 0);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await pool.end();
  }
});