import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import {
  courseBookingsTable, coursesTable, db, memberNotificationsTable,
  membersTable, organizationsTable, pool, studiosTable,
} from "@workspace/db";
import memberAppRouter from "../src/routes/member-app";
import { BookingError, cancelCourseBooking } from "../src/lib/course-bookings";

test("members can read and acknowledge only their own course notifications", async () => {
  const suffix = randomUUID();
  const [organization] = await db.insert(organizationsTable)
    .values({ name: `Notices ${suffix}` }).returning();
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    const [studio] = await db.insert(studiosTable)
      .values({ organizationId: organization.id, name: "Teststudio", city: "Berlin" }).returning();
    const [own, other, waiting] = await db.insert(membersTable).values([
      { studioId: studio.id, fullName: "First", email: `first-${suffix}@example.invalid`,
        membershipType: "Basic", clerkUserId: `notice-first-${suffix}` },
      { studioId: studio.id, fullName: "Second", email: `second-${suffix}@example.invalid`,
        membershipType: "Basic", clerkUserId: `notice-second-${suffix}` },
      { studioId: studio.id, fullName: "Waiting", email: `waiting-${suffix}@example.invalid`,
        membershipType: "Basic", clerkUserId: `notice-waiting-${suffix}` },
    ]).returning();
    const [course] = await db.insert(coursesTable).values({
      studioId: studio.id, title: "Testkurs", instructor: "Trainer",
      startsAt: new Date(Date.now() + 86400000), endsAt: new Date(Date.now() + 90000000),
      capacity: 2, room: "A",
    }).returning();
    const [ownBooking, otherBooking] = await db.insert(courseBookingsTable).values([
      { courseId: course.id, memberId: own.id, status: "confirmed" },
      { courseId: course.id, memberId: other.id, status: "confirmed" },
    ]).returning();
    const [waitingBooking] = await db.insert(courseBookingsTable)
      .values({ courseId: course.id, memberId: waiting.id, status: "waitlisted" }).returning();
    await db.update(coursesTable).set({ enrolled: 2, status: "full" }).where(eq(coursesTable.id, course.id));
    const [ownNotice, otherNotice] = await db.insert(memberNotificationsTable).values([
      { bookingId: ownBooking.id, memberId: own.id, courseId: course.id, title: "Dein Platz", body: "Bestätigt" },
      { bookingId: otherBooking.id, memberId: other.id, courseId: course.id, title: "Fremder Platz", body: "Bestätigt" },
    ]).returning();

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user") ?? null;
      const auth = Object.assign(() => ({ userId, tokenType: "session_token" }), {
        [Symbol.for("@clerk/express.auth")]: true,
      });
      Object.assign(req, { auth });
      next();
    });
    app.use("/api", memberAppRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    async function request(user: string | null, method: "GET" | "PATCH", path: string) {
      const response = await fetch(`${base}${path}`, {
        method, headers: user ? { "x-test-user": user } : {},
      });
      return { status: response.status, body: await response.json() as unknown };
    }

    assert.equal((await request(null, "GET", "/member/notifications")).status, 401);
    assert.equal((await request("unlinked", "GET", "/member/notifications")).status, 403);
    const list = await request(own.clerkUserId, "GET", "/member/notifications");
    assert.equal(list.status, 200);
    assert.deepEqual((list.body as Array<{ id: number }>).map(item => item.id), [ownNotice.id]);
    assert.equal((await request(own.clerkUserId, "PATCH", `/member/notifications/${otherNotice.id}/read`)).status, 404);
    const unreadOther = await db.select({ readAt: memberNotificationsTable.readAt })
      .from(memberNotificationsTable).where(eq(memberNotificationsTable.id, otherNotice.id));
    assert.equal(unreadOther[0].readAt, null);
    const marked = await request(own.clerkUserId, "PATCH", `/member/notifications/${ownNotice.id}/read`);
    assert.equal(marked.status, 200);
    assert.ok((marked.body as { readAt: string }).readAt);
    assert.equal((await request(other.clerkUserId, "GET", "/member/notifications")).status, 200);

    await cancelCourseBooking(course.id, own.id);
    const promotion = await request(waiting.clerkUserId, "GET", "/member/notifications");
    assert.equal(promotion.status, 200);
    const messages = promotion.body as Array<{ id: number; courseId: number; title: string; body: string; readAt: string | null }>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].courseId, course.id);
    assert.match(messages[0].body, /Testkurs.*\d{4}.*Uhr/);
    assert.equal(messages[0].readAt, null);
    assert.equal((await db.select().from(courseBookingsTable)
      .where(eq(courseBookingsTable.id, waitingBooking.id)))[0].status, "confirmed");
    await assert.rejects(cancelCourseBooking(course.id, own.id),
      (error) => error instanceof BookingError && error.status === 404);
    const afterReload = await request(waiting.clerkUserId, "GET", "/member/notifications");
    assert.deepEqual(afterReload.body, promotion.body, "the notice remains in the database after another request");
    assert.deepEqual(
      ((await request(other.clerkUserId, "GET", "/member/notifications")).body as Array<{ id: number }>).map(item => item.id),
      [otherNotice.id],
    );
  } finally {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => error ? reject(error) : resolve()),
      );
    }
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organization.id));
    await pool.end();
  }
});