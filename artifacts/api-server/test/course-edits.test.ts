import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { and, eq } from "drizzle-orm";
import express from "express";
import {
  courseBookingsTable,
  courseEditPushDeliveriesTable,
  coursesTable,
  db,
  memberNotificationsTable,
  memberPushSubscriptionsTable,
  membersTable,
  organizationsTable,
  pool,
  roomClosuresTable,
  staffTable,
  studiosTable,
  trainerAbsencesTable,
} from "@workspace/db";
import { processCourseEditPushDeliveries } from "../src/lib/course-edit-push";
import { createCourseEditsRouter } from "../src/routes/course-edits";

after(async () => {
  await pool.end();
});

test("course edits enforce manager/studio/revision boundaries and notify only eligible bookings", async () => {
  const suffix = randomUUID();
  let organizationId: number | undefined;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    const [organization] = await db.insert(organizationsTable)
      .values({ name: `Course edit ${suffix}` }).returning();
    organizationId = organization.id;
    const [studio, otherStudio] = await db.insert(studiosTable).values([
      { organizationId, name: `Studio ${suffix}`, city: "Berlin" },
      { organizationId, name: `Other studio ${suffix}`, city: "Berlin" },
    ]).returning();
    const users = {
      manager: `course-edit-manager-${suffix}`,
      secondManager: `course-edit-manager-two-${suffix}`,
      employee: `course-edit-employee-${suffix}`,
    };
    await db.insert(staffTable).values([
      { clerkUserId: users.manager, organizationId, studioId: studio.id, fullName: "Manager", email: `manager-${suffix}@example.invalid`, role: "studio_manager" },
      { clerkUserId: users.secondManager, organizationId, studioId: otherStudio.id, fullName: "Other Manager", email: `other-manager-${suffix}@example.invalid`, role: "studio_manager" },
      { clerkUserId: users.employee, organizationId, studioId: studio.id, fullName: "Employee", email: `employee-${suffix}@example.invalid`, role: "studio_employee" },
    ]);
    const [confirmed, waitlisted, inactive, elsewhere] = await db.insert(membersTable).values([
      { studioId: studio.id, fullName: "Confirmed", email: `confirmed-${suffix}@example.invalid`, membershipType: "Standard" },
      { studioId: studio.id, fullName: "Waitlisted", email: `waiting-${suffix}@example.invalid`, membershipType: "Standard" },
      { studioId: studio.id, fullName: "Inactive", email: `inactive-${suffix}@example.invalid`, membershipType: "Standard", status: "paused" },
      { studioId: otherStudio.id, fullName: "Elsewhere", email: `elsewhere-${suffix}@example.invalid`, membershipType: "Standard" },
    ]).returning();
    const startsAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    const [course, foreignCourse] = await db.insert(coursesTable).values([
      { studioId: studio.id, title: "Original class", instructor: "Trainer One", startsAt, endsAt, capacity: 1, enrolled: 1, room: "Room A", status: "full" },
      { studioId: otherStudio.id, title: "Foreign class", instructor: "Trainer Two", startsAt, endsAt, capacity: 5, room: "Room A" },
    ]).returning();
    await db.insert(coursesTable).values({
      studioId: studio.id, title: "Other class", instructor: "Trainer Three",
      startsAt, endsAt, capacity: 5, room: "Room Conflict",
    });
    const [bookedConfirmed, bookedWaitlisted, bookedInactive, bookedElsewhere] = await db.insert(courseBookingsTable).values([
      { courseId: course.id, memberId: confirmed.id, status: "confirmed" },
      { courseId: course.id, memberId: waitlisted.id, status: "waitlisted" },
      { courseId: course.id, memberId: inactive.id, status: "confirmed" },
      // Deliberately corrupt/mismatched membership data must not become a
      // cross-studio notification recipient.
      { courseId: course.id, memberId: elsewhere.id, status: "confirmed" },
    ]).returning();
    const subscriptions = [
      { subscriptionId: `sub-confirmed-${suffix}`, memberId: confirmed.id },
      { subscriptionId: `sub-waitlisted-${suffix}`, memberId: waitlisted.id },
      { subscriptionId: `sub-inactive-${suffix}`, memberId: inactive.id },
      { subscriptionId: `sub-elsewhere-${suffix}`, memberId: elsewhere.id },
    ];
    await db.insert(memberPushSubscriptionsTable).values(subscriptions);

    const app = express();
    app.use(express.json());
    app.use(createCourseEditsRouter({
      userIdFromRequest: (req) => req.header("x-test-user") ?? null,
    }));
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/courses/${course.id}`;
    const editBody = (revision: number, values: Record<string, unknown> = {}) => ({
      title: "Updated class",
      instructor: "Trainer One",
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      room: "Room B",
      revision,
      ...values,
    });
    const patch = (user: string | null, body: unknown, target = url) => fetch(target, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(user ? { "x-test-user": user } : {}),
      },
      body: JSON.stringify(body),
    });

    assert.equal((await patch(null, editBody(1))).status, 401);
    assert.equal((await patch(users.employee, editBody(1))).status, 403);
    assert.equal((await patch(users.secondManager, editBody(1))).status, 404);
    assert.equal((await patch(users.manager, editBody(1), `http://127.0.0.1:${address.port}/courses/${foreignCourse.id}`)).status, 404);
    assert.equal((await patch(users.manager, editBody(1, { title: " " }))).status, 400);
    assert.equal((await patch(users.manager, editBody(1, {
      endsAt: new Date(startsAt.getTime() - 1000).toISOString(),
    }))).status, 400);
    assert.equal((await patch(users.manager, editBody(1, {
      startsAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      endsAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }))).status, 409);
    assert.equal((await patch(users.manager, editBody(1, { room: "Room Conflict" }))).status, 409);
    assert.equal((await patch(users.manager, editBody(1, { status: "cancelled" }))).status, 400);
    assert.equal((await patch(users.manager, editBody(9))).status, 409);

    const noOp = await patch(users.manager, editBody(1, {
      title: course.title,
      room: course.room,
    }));
    assert.equal(noOp.status, 200);
    assert.equal((await noOp.json() as { revision: number }).revision, 1);
    assert.equal((await db.select().from(memberNotificationsTable)
      .where(eq(memberNotificationsTable.courseId, course.id))).length, 0);

    const concurrentUpdates = await Promise.all([
      patch(users.manager, editBody(1)),
      patch(users.manager, editBody(1)),
    ]);
    assert.deepEqual(concurrentUpdates.map((response) => response.status).sort(), [200, 409]);
    const updatedResponse = concurrentUpdates.find((response) => response.status === 200)!;
    const updated = await updatedResponse.json() as { revision: number; enrolled: number; status: string };
    assert.equal(updated.revision, 2);
    assert.equal(updated.enrolled, 1);
    assert.equal(updated.status, "full");
    const [storedCourse] = await db.select().from(coursesTable).where(eq(coursesTable.id, course.id));
    assert.equal(storedCourse.revision, 2);
    assert.equal(storedCourse.enrolled, 1);
    const bookings = await db.select().from(courseBookingsTable)
      .where(eq(courseBookingsTable.courseId, course.id));
    assert.deepEqual(new Set(bookings.map((booking) => booking.id)), new Set([
      bookedConfirmed.id, bookedWaitlisted.id, bookedInactive.id, bookedElsewhere.id,
    ]));
    const notices = await db.select().from(memberNotificationsTable)
      .where(eq(memberNotificationsTable.courseId, course.id));
    assert.equal(notices.length, 2);
    assert.deepEqual(new Set(notices.map((notice) => notice.memberId)), new Set([confirmed.id, waitlisted.id]));
    assert.ok(notices.every((notice) => notice.body.includes("Updated class")));
    assert.ok(notices.every((notice) => !notice.body.toLowerCase().includes("krank")));
    const deliveries = await db.select().from(courseEditPushDeliveriesTable)
      .where(eq(courseEditPushDeliveriesTable.courseId, course.id));
    assert.equal(deliveries.length, 2);
    assert.deepEqual(new Set(deliveries.map((delivery) => delivery.memberId)), new Set([confirmed.id, waitlisted.id]));
    assert.equal(new Set(deliveries.map((delivery) => delivery.idempotencyKey)).size, 2);

    // A subsequent edit retires the prior revision's queued work and creates
    // fresh snapshots only for the revision being delivered.
    await db.update(courseEditPushDeliveriesTable).set({ status: "failed" })
      .where(and(
        eq(courseEditPushDeliveriesTable.courseId, course.id),
        eq(courseEditPushDeliveriesTable.memberId, confirmed.id),
      ));
    const secondStart = new Date(startsAt.getTime() + 24 * 60 * 60 * 1000);
    const secondEnd = new Date(endsAt.getTime() + 24 * 60 * 60 * 1000);
    const secondEdit = await patch(users.manager, editBody(2, {
      startsAt: secondStart.toISOString(),
      endsAt: secondEnd.toISOString(),
      room: "Room C",
    }));
    assert.equal(secondEdit.status, 200);
    const oldDeliveries = await db.select().from(courseEditPushDeliveriesTable)
      .where(and(
        eq(courseEditPushDeliveriesTable.courseId, course.id),
        eq(courseEditPushDeliveriesTable.courseRevision, 2),
      ));
    assert.ok(oldDeliveries.every((delivery) => delivery.status === "skipped"));

    // The member unlinks their subscription after the durable snapshot exists.
    await db.delete(memberPushSubscriptionsTable)
      .where(eq(memberPushSubscriptionsTable.subscriptionId, subscriptions[0]!.subscriptionId));
    const providerBodies: Array<Record<string, unknown>> = [];
    await processCourseEditPushDeliveries(course.id, async (_path, options) => {
      providerBodies.push(options?.body as Record<string, unknown>);
      return Response.json({ id: "provider-accepted" }, { status: 200 });
    });
    const currentDeliveries = await db.select().from(courseEditPushDeliveriesTable)
      .where(and(
        eq(courseEditPushDeliveriesTable.courseId, course.id),
        eq(courseEditPushDeliveriesTable.courseRevision, 3),
      ));
    assert.equal(currentDeliveries.find((delivery) => delivery.memberId === confirmed.id)?.status, "skipped");
    assert.equal(currentDeliveries.find((delivery) => delivery.memberId === waitlisted.id)?.status, "sent");
    assert.equal(providerBodies.length, 1);
    assert.deepEqual(providerBodies[0]?.data, { courseId: course.id, memberId: waitlisted.id });
    assert.equal((providerBodies[0]?.headings as { en: string }).en, "Dein Kursplan hat sich geändert");
    assert.equal((providerBodies[0]?.contents as { en: string }).en,
      "Dein Kursplan hat sich geändert. Prüfe die aktuellen Details in Fiudia.");
    assert.equal(providerBodies[0]?.idempotency_key, currentDeliveries.find((delivery) => delivery.memberId === waitlisted.id)?.idempotencyKey);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    if (organizationId !== undefined) {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    }
  }
});

test("course edit rejects future schedules that conflict with trainer absence or room closure", async () => {
  const suffix = randomUUID();
  let organizationId: number | undefined;
  let validationStudioId: number | undefined;
  try {
    const [organization] = await db.insert(organizationsTable)
      .values({ name: `Course edit validation ${suffix}` }).returning();
    organizationId = organization.id;
    const [studio] = await db.insert(studiosTable).values({
      organizationId, name: `Validation ${suffix}`, city: "Berlin",
    }).returning();
    validationStudioId = studio.id;
    const user = `course-edit-validation-${suffix}`;
    await db.insert(staffTable).values({
      clerkUserId: user, organizationId, studioId: studio.id, fullName: "Manager",
      email: `validation-${suffix}@example.invalid`, role: "studio_manager",
    });
    const startsAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(startsAt);
    const [course] = await db.insert(coursesTable).values({
      studioId: studio.id, title: "Validation class", instructor: "Trainer",
      startsAt, endsAt, capacity: 4, room: "A",
    }).returning();
    await db.insert(trainerAbsencesTable).values({
      studioId: studio.id, instructor: "Absent Trainer",
      fromDate: localDate,
      toDate: localDate,
      createdByStaffId: (await db.select({ id: staffTable.id }).from(staffTable)
        .where(eq(staffTable.clerkUserId, user)))[0]!.id,
    });
    const [closure] = await db.insert(roomClosuresTable).values({
      studioId: studio.id, roomName: "Closed", fromDate: localDate,
      toDate: localDate, reason: "repair", responsible: "manager",
      createdByStaffId: (await db.select({ id: staffTable.id }).from(staffTable)
        .where(eq(staffTable.clerkUserId, user)))[0]!.id,
    }).returning();
    const [staff] = await db.select().from(staffTable).where(eq(staffTable.clerkUserId, user));
    const { once } = await import("node:events");
    const app = express();
    app.use(express.json());
    app.use(createCourseEditsRouter({
      userIdFromRequest: () => staff.clerkUserId,
    }));
    const server = app.listen(0);
    await once(server, "listening");
    try {
      const address = server.address() as AddressInfo;
      const send = (instructor: string, room: string) => fetch(
        `http://127.0.0.1:${address.port}/courses/${course.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: course.title, instructor, startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(), room, revision: course.revision,
          }),
        },
      );
      assert.equal((await send("Absent Trainer", "A")).status, 409);
      assert.equal((await send("Available Trainer", "Closed")).status, 409);
      assert.equal((await send("Available Trainer", "A")).status, 200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await db.delete(roomClosuresTable).where(eq(roomClosuresTable.id, closure.id));
    }
  } finally {
    if (validationStudioId !== undefined) {
      await db.delete(trainerAbsencesTable).where(eq(trainerAbsencesTable.studioId, validationStudioId));
      await db.delete(roomClosuresTable).where(eq(roomClosuresTable.studioId, validationStudioId));
    }
    if (organizationId !== undefined) {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    }
  }
});

test("course edit push retries with a stable key and skips superseded snapshots", async () => {
  const suffix = randomUUID();
  let organizationId: number | undefined;
  try {
    const [organization] = await db.insert(organizationsTable)
      .values({ name: `Course push retry ${suffix}` }).returning();
    organizationId = organization.id;
    const [studio] = await db.insert(studiosTable).values({
      organizationId, name: `Push retry ${suffix}`, city: "Berlin",
    }).returning();
    const [member] = await db.insert(membersTable).values({
      studioId: studio.id, fullName: "Push recipient", email: `push-${suffix}@example.invalid`,
      membershipType: "Standard",
    }).returning();
    const startsAt = new Date(Date.now() + 96 * 60 * 60 * 1000);
    const [course] = await db.insert(coursesTable).values({
      studioId: studio.id, title: "Push retry class", instructor: "Trainer", startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000), capacity: 2, room: "A",
    }).returning();
    const [booking] = await db.insert(courseBookingsTable).values({
      courseId: course.id, memberId: member.id, status: "confirmed",
    }).returning();
    const [subscription] = await db.insert(memberPushSubscriptionsTable).values({
      subscriptionId: `retry-${suffix}`, memberId: member.id,
    }).returning();
    await db.insert(courseEditPushDeliveriesTable).values({
      courseId: course.id, courseRevision: 1, bookingId: booking.id, memberId: member.id,
      subscriptionId: subscription.subscriptionId, title: "Course changed",
      body: "New details", idempotencyKey: `course-edit-test-${suffix}`,
      nextAttemptAt: new Date(Date.now() - 1000),
    });
    const attempts: string[] = [];
    await processCourseEditPushDeliveries(course.id, async (_path, options) => {
      attempts.push((options?.body as { idempotency_key: string }).idempotency_key);
      return Response.json({}, { status: 503 });
    });
    let [delivery] = await db.select().from(courseEditPushDeliveriesTable)
      .where(eq(courseEditPushDeliveriesTable.courseId, course.id));
    assert.equal(delivery.status, "failed");
    assert.equal(delivery.attemptCount, 1);
    assert.ok(delivery.nextAttemptAt > new Date());
    await db.update(courseEditPushDeliveriesTable).set({
      nextAttemptAt: new Date(Date.now() - 1000),
    }).where(eq(courseEditPushDeliveriesTable.id, delivery.id));
    await processCourseEditPushDeliveries(course.id, async (_path, options) => {
      attempts.push((options?.body as { idempotency_key: string }).idempotency_key);
      return Response.json({ id: "provider-ok" }, { status: 200 });
    });
    [delivery] = await db.select().from(courseEditPushDeliveriesTable)
      .where(eq(courseEditPushDeliveriesTable.id, delivery.id));
    assert.equal(delivery.status, "sent");
    assert.equal(delivery.attemptCount, 2);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0], attempts[1]);
    assert.equal(attempts[0], delivery.idempotencyKey);
  } finally {
    if (organizationId !== undefined) {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    }
  }
});

test("in-flight course-edit push stays truthful and contains no stale details during a newer edit and opt-out", async () => {
  const suffix = randomUUID();
  let organizationId: number | undefined;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  let releaseFirst: ((response: Response) => void) | undefined;
  let worker: Promise<void> | undefined;
  try {
    const [organization] = await db.insert(organizationsTable)
      .values({ name: `Course edit send race ${suffix}` }).returning();
    organizationId = organization.id;
    const [studio] = await db.insert(studiosTable).values({
      organizationId, name: `Course send race ${suffix}`, city: "Berlin",
    }).returning();
    const [manager] = await db.insert(staffTable).values({
      clerkUserId: `course-edit-race-manager-${suffix}`,
      organizationId,
      studioId: studio.id,
      fullName: "Race Manager",
      email: `race-manager-${suffix}@example.invalid`,
      role: "studio_manager",
    }).returning();
    const [memberA, memberB] = await db.insert(membersTable).values([
      { studioId: studio.id, fullName: "Race member A", email: `race-a-${suffix}@example.invalid`, membershipType: "Standard" },
      { studioId: studio.id, fullName: "Race member B", email: `race-b-${suffix}@example.invalid`, membershipType: "Standard" },
    ]).returning();
    const startsAt = new Date(Date.now() + 96 * 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    const [course] = await db.insert(coursesTable).values({
      studioId: studio.id,
      title: "Original race class",
      instructor: "Original Trainer",
      startsAt,
      endsAt,
      capacity: 4,
      room: "Original Room",
    }).returning();
    const [bookingA, bookingB] = await db.insert(courseBookingsTable).values([
      { courseId: course.id, memberId: memberA.id, status: "confirmed" },
      { courseId: course.id, memberId: memberB.id, status: "confirmed" },
    ]).returning();
    const [subscriptionA] = await db.insert(memberPushSubscriptionsTable).values({
      subscriptionId: `race-sub-a-${suffix}`, memberId: memberA.id,
    }).returning();

    const app = express();
    app.use(express.json());
    app.use(createCourseEditsRouter({
      userIdFromRequest: (req) => req.header("x-test-user") ?? null,
    }));
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address() as AddressInfo;
    const patch = (revision: number, details: {
      title: string; instructor: string; room: string;
    }) => fetch(`http://127.0.0.1:${address.port}/courses/${course.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-user": manager.clerkUserId },
      body: JSON.stringify({
        ...details,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        revision,
      }),
    });

    const firstEdit = await patch(1, {
      title: "Private first-edition title",
      instructor: "Private first-edition trainer",
      room: "Private first-edition room",
    });
    assert.equal(firstEdit.status, 200);

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let firstCall = true;
    const sentPayloads: Array<Record<string, unknown>> = [];
    const delayedProxy = async (_path: string, options?: { body?: unknown }) => {
      sentPayloads.push(options?.body as Record<string, unknown>);
      if (firstCall) {
        firstCall = false;
        markStarted();
        return new Promise<Response>((resolve) => { releaseFirst = resolve; });
      }
      return Response.json({ id: `race-provider-${suffix}` }, { status: 200 });
    };
    worker = processCourseEditPushDeliveries(course.id, delayedProxy);
    await started;

    const [inFlightDelivery] = await db.select().from(courseEditPushDeliveriesTable).where(and(
      eq(courseEditPushDeliveriesTable.courseId, course.id),
      eq(courseEditPushDeliveriesTable.courseRevision, 2),
    ));
    assert.equal(inFlightDelivery.status, "sending");

    // Simulate a member opt-out while the first provider request is already
    // pending, then edit the course again. The active send cannot be recalled.
    await db.delete(memberPushSubscriptionsTable)
      .where(eq(memberPushSubscriptionsTable.subscriptionId, subscriptionA.subscriptionId));
    await db.insert(memberPushSubscriptionsTable).values({
      subscriptionId: `race-sub-b-${suffix}`, memberId: memberB.id,
    });
    const latestEdit = await patch(2, {
      title: "Latest class snapshot",
      instructor: "Latest trainer snapshot",
      room: "Latest room snapshot",
    });
    assert.equal(latestEdit.status, 200);

    const [stillSending] = await db.select().from(courseEditPushDeliveriesTable)
      .where(eq(courseEditPushDeliveriesTable.id, inFlightDelivery.id));
    assert.equal(stillSending.status, "sending", "new edits do not falsely mark a provider request skipped");
    const latestDelivery = await db.select().from(courseEditPushDeliveriesTable).where(and(
      eq(courseEditPushDeliveriesTable.courseId, course.id),
      eq(courseEditPushDeliveriesTable.courseRevision, 3),
    ));
    assert.equal(latestDelivery.length, 1);
    assert.equal(latestDelivery[0].memberId, memberB.id);
    assert.equal(latestDelivery[0].status, "pending", "new subscribed recipients get a durable queued delivery");

    const courseNotices = await db.select().from(memberNotificationsTable).where(and(
      eq(memberNotificationsTable.courseId, course.id),
      eq(memberNotificationsTable.title, "Deine Kursdetails wurden aktualisiert"),
    ));
    // Both edits create one notice per booked member; isolate the second
    // revision's snapshot rather than counting notifications from both edits.
    const latestNotices = courseNotices.filter((notice) => notice.body.includes("Latest class snapshot"));
    assert.equal(latestNotices.length, 2);
    assert.ok(latestNotices.every((notice) =>
      notice.body.includes("Latest class snapshot") &&
      notice.body.includes("aktuellen Kursplan in Fiudia") &&
      notice.courseId === course.id));

    const payload = sentPayloads[0];
    assert.equal((payload.headings as { en: string }).en, "Dein Kursplan hat sich geändert");
    assert.equal((payload.contents as { en: string }).en,
      "Dein Kursplan hat sich geändert. Prüfe die aktuellen Details in Fiudia.");
    assert.doesNotMatch(JSON.stringify(payload),
      /Private first-edition|Latest class snapshot|first-edition trainer|Latest trainer snapshot|first-edition room|Latest room snapshot/);

    releaseFirst!(Response.json({ id: `race-provider-${suffix}` }, { status: 200 }));
    await worker;
    worker = undefined;
    const [settledDelivery] = await db.select().from(courseEditPushDeliveriesTable)
      .where(eq(courseEditPushDeliveriesTable.id, inFlightDelivery.id));
    assert.equal(settledDelivery.status, "sent", "the in-flight provider acceptance is recorded truthfully");
    assert.equal((await db.select().from(courseEditPushDeliveriesTable)
      .where(eq(courseEditPushDeliveriesTable.id, latestDelivery[0].id)))[0].status, "sent");
    assert.equal(sentPayloads.length, 2);
  } finally {
    releaseFirst?.(Response.json({ id: `race-provider-finally-${suffix}` }, { status: 200 }));
    if (worker) await worker.catch(() => undefined);
    if (server) await new Promise<void>((resolve, reject) =>
      server!.close((error) => error ? reject(error) : resolve()));
    if (organizationId !== undefined) {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    }
  }
});
