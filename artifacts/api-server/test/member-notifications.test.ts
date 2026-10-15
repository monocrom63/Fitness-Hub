import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import {
  courseBookingsTable, coursesTable, db, memberNotificationsTable, waitlistEmailDeliveriesTable,
  membersTable, organizationModulesTable, organizationsTable, pool, studiosTable,
} from "@workspace/db";
import memberAppRouter from "../src/routes/member-app";
import { BookingError, cancelCourseBooking } from "../src/lib/course-bookings";
import { promotionNotice, waitlistEmailDraft } from "../src/lib/waitlist-email";

test("waitlist email draft has the intended sender and no HTML or provider side effects", () => {
  const notice = promotionNotice("Testkurs", new Date("2026-10-01T16:00:00Z"));
  const draft = waitlistEmailDraft("member@example.invalid", notice);
  assert.deepEqual(draft, {
    from: "mail@fiudia.com",
    to: "member@example.invalid",
    subject: "Fiudia | Dein Kursplatz ist bestätigt",
    text: `${notice.body}\n\nDein Fiudia-Team`,
  });
  assert.match(draft.text, /Testkurs.*2026.*Uhr/);
});

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
    async function request(user: string | null, method: "GET" | "PATCH", path: string, data?: unknown) {
      const response = await fetch(`${base}${path}`, {
        method, headers: { ...(user ? { "x-test-user": user } : {}), ...(data ? { "content-type": "application/json" } : {}) },
        body: data ? JSON.stringify(data) : undefined,
      });
      return { status: response.status, body: await response.json() as unknown };
    }

    assert.equal((await request(null, "GET", "/member/notifications")).status, 401);
    assert.equal((await request("unlinked", "GET", "/member/notifications")).status, 403);
    const unreadCountPath = "/member/notifications/unread-count";
    const unreadCount = async (user: string | null) => {
      const response = await request(user, "GET", unreadCountPath);
      assert.equal(response.status, 200);
      return (response.body as { count: number }).count;
    };
    assert.equal((await request(null, "GET", unreadCountPath)).status, 401);
    assert.equal((await request("unlinked", "GET", unreadCountPath)).status, 403);
    assert.equal(await unreadCount(own.clerkUserId), 1);
    assert.equal(await unreadCount(other.clerkUserId), 1);
    const settings = "/member/notification-settings";
    assert.equal((await request(null, "PATCH", settings, { waitlistEmailEnabled: true })).status, 401);
    assert.equal((await request("unlinked", "PATCH", settings, { waitlistEmailEnabled: true })).status, 403);
    assert.equal((await request(waiting.clerkUserId, "PATCH", settings, { waitlistEmailEnabled: "yes" })).status, 400);
    assert.equal(((await request(waiting.clerkUserId, "GET", "/member/me")).body as { waitlistEmailEnabled: boolean }).waitlistEmailEnabled, false);
    const enabled = await request(waiting.clerkUserId, "PATCH", settings, { waitlistEmailEnabled: true });
    assert.equal(enabled.status, 200);
    assert.equal((enabled.body as { waitlistEmailEnabled: boolean }).waitlistEmailEnabled, true);
    assert.equal(((await request(waiting.clerkUserId, "GET", "/member/me")).body as { waitlistEmailEnabled: boolean }).waitlistEmailEnabled, true);
    assert.equal(((await request(other.clerkUserId, "GET", "/member/me")).body as { waitlistEmailEnabled: boolean }).waitlistEmailEnabled, false);
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
    assert.equal((marked.body as { emailDeliveryStatus: string | null }).emailDeliveryStatus, null);
    assert.equal(await unreadCount(own.clerkUserId), 0);
    assert.equal(await unreadCount(other.clerkUserId), 1);
    assert.equal((await request(other.clerkUserId, "GET", "/member/notifications")).status, 200);

    await cancelCourseBooking(course.id, own.id);
    const promotion = await request(waiting.clerkUserId, "GET", "/member/notifications");
    assert.equal(promotion.status, 200);
    const messages = promotion.body as Array<{ id: number; courseId: number; title: string; body: string; readAt: string | null; emailDeliveryStatus: string | null }>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].courseId, course.id);
    assert.match(messages[0].body, /Testkurs.*\d{4}.*Uhr/);
    assert.equal(messages[0].readAt, null);
    assert.equal(messages[0].emailDeliveryStatus, "pending");
    assert.equal((await db.select({ emailRequested: memberNotificationsTable.emailRequested })
      .from(memberNotificationsTable).where(eq(memberNotificationsTable.id, messages[0].id)))[0].emailRequested, 1);
    const [queuedEmail] = await db.select().from(waitlistEmailDeliveriesTable)
      .where(eq(waitlistEmailDeliveriesTable.notificationId, messages[0].id));
    assert.equal(queuedEmail.status, "pending");
    await db.update(waitlistEmailDeliveriesTable).set({ status: "failed", error: "Temporary failure" })
      .where(eq(waitlistEmailDeliveriesTable.id, queuedEmail.id));
    const afterFailure = await request(waiting.clerkUserId, "GET", "/member/notifications");
    assert.equal((afterFailure.body as typeof messages)[0].emailDeliveryStatus, "failed");
    const disabled = await request(waiting.clerkUserId, "PATCH", settings, { waitlistEmailEnabled: false });
    assert.equal((disabled.body as { waitlistEmailEnabled: boolean }).waitlistEmailEnabled, false);
    assert.equal((await db.select({ emailRequested: memberNotificationsTable.emailRequested })
      .from(memberNotificationsTable).where(eq(memberNotificationsTable.id, messages[0].id)))[0].emailRequested, 0);
    const [cancelledEmail] = await db.select().from(waitlistEmailDeliveriesTable)
      .where(eq(waitlistEmailDeliveriesTable.id, queuedEmail.id));
    assert.equal(cancelledEmail.status, "skipped");
    assert.equal((await db.select().from(courseBookingsTable)
      .where(eq(courseBookingsTable.id, waitingBooking.id)))[0].status, "confirmed");
    await assert.rejects(cancelCourseBooking(course.id, own.id),
      (error) => error instanceof BookingError && error.status === 404);
    const afterReload = await request(waiting.clerkUserId, "GET", "/member/notifications");
    assert.deepEqual(afterReload.body, [{ ...messages[0], emailDeliveryStatus: null }],
      "the notice remains after opt-out without implying an email is still queued");
    assert.deepEqual(
      ((await request(other.clerkUserId, "GET", "/member/notifications")).body as Array<{ id: number }>).map(item => item.id),
      [otherNotice.id],
    );

    // A notification remains actionable as a link after its course has left the
    // upcoming list, but must not expose unrelated historical courses.
    const pastStartsAt = new Date(Date.now() - 2 * 86400000);
    const pastEndsAt = new Date(pastStartsAt.getTime() + 3600000);
    await db.update(coursesTable).set({
      startsAt: pastStartsAt,
      endsAt: pastEndsAt,
    }).where(eq(coursesTable.id, course.id));
    const [unnotified] = await db.insert(coursesTable).values({
      studioId: studio.id, title: "Ohne Hinweis", instructor: "Trainer",
      startsAt: new Date(Date.now() - 3 * 86400000),
      endsAt: new Date(Date.now() - 3 * 86400000 + 3600000),
      capacity: 2, room: "B",
    }).returning();
    const [foreignStudio] = await db.insert(studiosTable).values({
      organizationId: organization.id, name: "Other studio", city: "Berlin",
    }).returning();
    const [foreignCourse] = await db.insert(coursesTable).values({
      studioId: foreignStudio.id, title: "Other studio course", instructor: "Trainer",
      startsAt: new Date(Date.now() - 4 * 86400000),
      endsAt: new Date(Date.now() - 4 * 86400000 + 3600000),
      capacity: 2, room: "C",
    }).returning();
    const [foreignBooking] = await db.insert(courseBookingsTable).values({
      courseId: foreignCourse.id, memberId: own.id, status: "confirmed",
    }).returning();
    await db.insert(memberNotificationsTable).values({
      bookingId: foreignBooking.id, memberId: own.id, courseId: foreignCourse.id,
      title: "Stale notification", body: "Other studio",
    });
    const courseIds = async (user: string | null, path: string) => {
      const result = await request(user, "GET", path);
      assert.equal(result.status, 200);
      return (result.body as Array<{ id: number }>).map(item => item.id);
    };
    assert.deepEqual(await courseIds(own.clerkUserId, "/member/courses"), []);
    assert.deepEqual(await courseIds(own.clerkUserId, `/member/courses?courseId=${course.id}`), [course.id]);
    assert.deepEqual(await courseIds(own.clerkUserId, `/member/courses?courseId=${unnotified.id}`), []);
    assert.deepEqual(await courseIds(own.clerkUserId, `/member/courses?courseId=${foreignCourse.id}`), []);
    assert.deepEqual(await courseIds(waiting.clerkUserId, `/member/courses?courseId=${course.id}`), [course.id]);
    assert.equal((await request(own.clerkUserId, "GET", "/member/courses?courseId=invalid")).status, 400);

    const detailPath = `/member/courses/${course.id}`;
    assert.equal((await request(null, "GET", detailPath)).status, 401);
    assert.equal((await request("unlinked", "GET", detailPath)).status, 403);
    const detail = await request(own.clerkUserId, "GET", detailPath);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body, {
      id: course.id, title: course.title, instructor: course.instructor,
      startsAt: pastStartsAt.toISOString(),
      endsAt: pastEndsAt.toISOString(),
      capacity: course.capacity, enrolled: 2, room: course.room,
      studioName: studio.name, bookingStatus: null, waitlistPosition: null, status: "full",
    });
    assert.equal((await request(own.clerkUserId, "GET", `/member/courses/${unnotified.id}`)).status, 404);
    const deniedForeign = await request(own.clerkUserId, "GET", `/member/courses/${foreignCourse.id}`);
    const missing = await request(own.clerkUserId, "GET", "/member/courses/2147483647");
    assert.equal(deniedForeign.status, 404);
    assert.deepEqual(deniedForeign, missing, "foreign and missing courses have indistinguishable responses");
    const waitingDetail = await request(waiting.clerkUserId, "GET", detailPath);
    assert.equal(waitingDetail.status, 200);
    assert.equal((waitingDetail.body as { bookingStatus: string }).bookingStatus, "confirmed");
    for (const invalid of ["0", "-1", "1.5", "invalid", "2147483648"]) {
      assert.equal((await request(own.clerkUserId, "GET", `/member/courses/${invalid}`)).status, 400);
    }
    await db.update(coursesTable).set({ status: "cancelled" }).where(eq(coursesTable.id, course.id));
    assert.equal(((await request(own.clerkUserId, "GET", detailPath)).body as { status: string }).status, "cancelled");

    const sharedTimestamp = new Date("2099-01-01T00:00:00.000Z");
    const [historicalCourse] = await db.insert(coursesTable).values({
      studioId: studio.id, title: "Nur auf Seite zwei", instructor: "Trainer",
      startsAt: new Date(Date.now() - 10 * 86400000),
      endsAt: new Date(Date.now() - 10 * 86400000 + 3600000),
      capacity: 2, room: "D",
    }).returning();
    const [historicalBooking] = await db.insert(courseBookingsTable).values({
      courseId: historicalCourse.id, memberId: own.id, status: "confirmed",
    }).returning();
    const pagedNotices = await db.insert(memberNotificationsTable).values(
      Array.from({ length: 55 }, (_, index) => ({
        bookingId: index === 0 ? historicalBooking.id : ownBooking.id,
        memberId: own.id,
        courseId: index === 0 ? historicalCourse.id : course.id,
        title: `History ${index + 1}`,
        body: "Pagination test",
        createdAt: sharedTimestamp,
      })),
    ).returning({ id: memberNotificationsTable.id });
    const firstPage = await request(own.clerkUserId, "GET", "/member/notifications");
    assert.equal(firstPage.status, 200);
    const firstPageItems = firstPage.body as Array<{ id: number; courseId: number }>;
    assert.equal(firstPageItems.length, 50, "the default page remains limited to the latest 50");
    assert.deepEqual(
      firstPageItems.map(({ id }) => id),
      pagedNotices.map(({ id }) => id).slice(-50).reverse(),
      "equal timestamps are ordered by descending id",
    );
    assert.ok(
      firstPageItems.every(({ courseId }) => courseId !== historicalCourse.id),
      "the distinct historical course is not linked from the first page",
    );
    assert.equal(await unreadCount(own.clerkUserId), 56,
      "count includes 55 new notices and the older notice beyond the first page");
    assert.equal(await unreadCount(other.clerkUserId), 1,
      "another account cannot see the first member's unread notices");
    assert.deepEqual(await courseIds(
      own.clerkUserId,
      `/member/courses?courseId=${firstPageItems[0].courseId}`,
    ), [course.id], "a paged historical notification still resolves to its course");

    const cursorId = firstPageItems[firstPageItems.length - 1].id;
    const nextPage = await request(own.clerkUserId, "GET", `/member/notifications?beforeId=${cursorId}`);
    assert.equal(nextPage.status, 200);
    const nextPageItems = nextPage.body as Array<{ id: number; courseId: number }>;
    const nextPageIds = nextPageItems.map(({ id }) => id);
    assert.deepEqual(nextPageIds.slice(0, 5), pagedNotices.map(({ id }) => id).slice(0, 5).reverse());
    assert.ok(nextPageIds.every(id => id < cursorId));
    assert.ok(
      nextPageItems.some(({ id, courseId }) => id === pagedNotices[0].id && courseId === historicalCourse.id),
      "the second page contains the sole notice for the distinct historical course",
    );
    const archivedDetail = await request(own.clerkUserId, "GET", `/member/courses/${historicalCourse.id}`);
    assert.equal(archivedDetail.status, 200, "courses from older pages have independent details");
    assert.equal((archivedDetail.body as { title: string }).title, historicalCourse.title);
    assert.equal((await request(other.clerkUserId, "GET", `/member/courses/${historicalCourse.id}`)).status, 404);
    assert.deepEqual(
      await courseIds(own.clerkUserId, `/member/courses?courseId=${historicalCourse.id}`),
      [historicalCourse.id],
      "the owner can resolve the old course linked only from page two",
    );
    assert.deepEqual(
      await courseIds(other.clerkUserId, `/member/courses?courseId=${historicalCourse.id}`),
      [],
      "another member cannot access the historical course through this notice",
    );
    assert.equal(
      (await request(own.clerkUserId, "PATCH", `/member/notifications/${pagedNotices[0].id}/read`)).status,
      200,
    );
    assert.equal(await unreadCount(own.clerkUserId), 55, "reading an older notice updates the count");
    assert.equal(
      (await request(own.clerkUserId, "PATCH", `/member/notifications/${pagedNotices[0].id}/read`)).status,
      200,
    );
    assert.equal(await unreadCount(own.clerkUserId), 55, "repeated marking cannot reduce the count twice");
    for (const invalidCursor of ["0", "-1", "1.5", "invalid", String(Number.MAX_SAFE_INTEGER)]) {
      assert.equal(
        (await request(own.clerkUserId, "GET", `/member/notifications?beforeId=${invalidCursor}`)).status,
        400,
        `invalid cursor ${invalidCursor} is rejected`,
      );
    }
    assert.equal(
      (await request(own.clerkUserId, "GET", `/member/notifications?beforeId=${otherNotice.id}`)).status,
      400,
      "a cursor belonging to another member is rejected",
    );
    const futureCourses = await db.insert(coursesTable).values(Array.from({ length: 61 }, (_, index) => ({
      studioId: studio.id, title: `Future ${index}`, instructor: "Trainer",
      startsAt: new Date(Date.now() + (index + 1) * 86400000),
      endsAt: new Date(Date.now() + (index + 1) * 86400000 + 3600000),
      capacity: 2, room: "A",
    }))).returning();
    const beyondLimit = futureCourses[60];
    assert.ok(!(await courseIds(own.clerkUserId, "/member/courses")).includes(beyondLimit.id));
    const distantDetail = await request(own.clerkUserId, "GET", `/member/courses/${beyondLimit.id}`);
    assert.equal(distantDetail.status, 200, "direct details are not restricted by the upcoming list limit");
    assert.equal((distantDetail.body as { id: number }).id, beyondLimit.id);
    await db.update(coursesTable).set({
      startsAt: new Date(Date.now() + 86400000), endsAt: new Date(Date.now() + 90000000),
    }).where(eq(coursesTable.id, foreignCourse.id));
    assert.equal((await request(own.clerkUserId, "GET", `/member/courses/${foreignCourse.id}`)).status, 404,
      "upcoming courses in another studio stay private even with an own stale notice");
    await db.insert(organizationModulesTable).values({ organizationId: organization.id, key: "courses", enabled: 0 });
    assert.equal((await request(own.clerkUserId, "GET", detailPath)).status, 404);
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