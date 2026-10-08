import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  closureEmailDeliveriesTable,
  courseBookingsTable,
  courseClosureResolutionsTable,
  courseEditPushDeliveriesTable,
  coursesTable,
  db,
  memberNotificationsTable,
  membersTable,
  organizationsTable,
  roomClosuresTable,
  staffTable,
  studiosTable,
} from "@workspace/db";
import courseBookingsRouter from "../src/routes/course-bookings";
import pulseRouter from "../src/routes/pulse";
import roomAssetsRouter from "../src/routes/room-assets";

test("manager room-closure workflow lists, resolves, notifies, and prevents cancelled-course booking", async () => {
  const suffix = randomUUID();
  let organizationId: number | undefined;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;

  try {
    const [organization] = await db.insert(organizationsTable)
      .values({ name: `Closure e2e ${suffix}` }).returning();
    organizationId = organization.id;
    const [studio, otherStudio] = await db.insert(studiosTable).values([
      { organizationId, name: `Closure studio ${suffix}`, city: "Berlin" },
      { organizationId, name: `Other closure studio ${suffix}`, city: "Berlin" },
    ]).returning();
    const [manager, employee] = await db.insert(staffTable).values([
      {
        clerkUserId: `closure-manager-${suffix}`,
        organizationId,
        studioId: studio.id,
        fullName: "Closure Manager",
        email: `closure-manager-${suffix}@example.invalid`,
        role: "studio_manager",
      },
      {
        clerkUserId: `closure-employee-${suffix}`,
        organizationId,
        studioId: studio.id,
        fullName: "Closure Employee",
        email: `closure-employee-${suffix}@example.invalid`,
        role: "studio_employee",
      },
    ]).returning();
    const [otherManager] = await db.insert(staffTable).values({
      clerkUserId: `closure-other-manager-${suffix}`,
      organizationId,
      studioId: otherStudio.id,
      fullName: "Other Closure Manager",
      email: `closure-other-manager-${suffix}@example.invalid`,
      role: "studio_manager",
    }).returning();

    const app = express();
    app.use(express.json());
    // Exercise the production router auth path with a signed-in test identity;
    // this does not call Clerk, Resend, or provider APIs.
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user") ?? null;
      const auth = Object.assign(() => ({ userId, tokenType: "session_token" }), {
        [Symbol.for("@clerk/express.auth")]: true,
      });
      Object.assign(req, { auth });
      next();
    });
    app.use("/api", roomAssetsRouter, courseBookingsRouter, pulseRouter);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    async function api(userId: string, method: string, path: string, body?: unknown) {
      const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
        method,
        headers: {
          "x-test-user": userId,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: response.status === 204 ? null : await response.json() as any,
      };
    }

    const createdRooms: string[] = [];
    for (const name of ["Room A", "Room Free", "Room Blocked", "Room Overlap"]) {
      const result = await api(manager.clerkUserId, "POST", `/studios/${studio.id}/rooms`, { name });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      createdRooms.push(result.body.name);
    }
    assert.deepEqual(createdRooms, ["Room A", "Room Free", "Room Blocked", "Room Overlap"]);

    const matchingCourseSpecs = [
      { title: "Course October 15", day: 15, room: "Room A" },
      { title: "Course October 18", day: 18, room: "Room A" },
      { title: "Course October 22", day: 22, room: "Room A" },
    ];
    const matchingCourses = await db.insert(coursesTable).values(matchingCourseSpecs.map(({ title, day, room }) => ({
      studioId: studio.id,
      title,
      instructor: "Trainer",
      startsAt: new Date(`2026-10-${day}T08:00:00.000Z`),
      endsAt: new Date(`2026-10-${day}T09:00:00.000Z`),
      capacity: 10,
      enrolled: 1,
      room,
    }))).returning();
    await db.insert(coursesTable).values([
      {
        studioId: otherStudio.id,
        title: "Other studio course",
        instructor: "Trainer",
        startsAt: new Date("2026-10-18T08:00:00.000Z"),
        endsAt: new Date("2026-10-18T09:00:00.000Z"),
        capacity: 10,
        room: "Room A",
      },
      {
        studioId: studio.id,
        title: "Other room course",
        instructor: "Trainer",
        startsAt: new Date("2026-10-18T08:00:00.000Z"),
        endsAt: new Date("2026-10-18T09:00:00.000Z"),
        capacity: 10,
        room: "Room Overlap",
      },
      ...[14, 31].map((day) => ({
        studioId: studio.id,
        title: `Outside date ${day}`,
        instructor: "Trainer",
        startsAt: new Date(`2026-10-${day}T08:00:00.000Z`),
        endsAt: new Date(`2026-10-${day}T09:00:00.000Z`),
        capacity: 10,
        room: "Room A",
      })),
    ]);
    const members = await db.insert(membersTable).values(matchingCourses.map(({ title }, index) => ({
      studioId: studio.id,
      fullName: `Closure member ${index + 1}`,
      email: `closure-member-${index + 1}-${suffix}@example.invalid`,
      membershipType: "Basic",
      status: "active",
    }))).returning();
    const courseBookings = await db.insert(courseBookingsTable).values(matchingCourses.map((course, index) => ({
      courseId: course.id,
      memberId: members[index].id,
      status: "confirmed",
    }))).returning();
    for (const [courseIndex, statuses] of [[0, ["pending", "failed", "sending"]], [1, ["pending", "failed", "sending"]]] as const) {
      await db.insert(courseEditPushDeliveriesTable).values(statuses.map((status, index) => ({
        courseId: matchingCourses[courseIndex].id,
        courseRevision: 1,
        bookingId: courseBookings[courseIndex].id,
        memberId: members[courseIndex].id,
        subscriptionId: `closure-${suffix}-${courseIndex}-${index}`,
        title: "Course update",
        body: "Course details changed.",
        idempotencyKey: `closure-${suffix}-${courseIndex}-${index}`,
        status,
        ...(status === "sending" ? { claimToken: `claim-${suffix}-${courseIndex}` } : {}),
      })));
    }

    // Seed an existing closure on the candidate room without creating a second
    // manager alert; this isolates the single alert generated by the workflow.
    await db.insert(roomClosuresTable).values({
      studioId: studio.id,
      roomName: "Room Blocked",
      fromDate: "2026-10-18",
      toDate: "2026-10-18",
      reason: "Unavailable",
      responsible: "Facilities",
      createdByStaffId: manager.id,
    });

    const closureResponse = await api(manager.clerkUserId, "POST", `/studios/${studio.id}/closures`, {
      roomName: "Room A",
      fromDate: "2026-10-15",
      toDate: "2026-10-30",
      reason: "Maintenance",
      responsible: "Facilities",
    });
    assert.equal(closureResponse.status, 201, JSON.stringify(closureResponse.body));
    const closureId = closureResponse.body.id as number;

    const managerPulse = await api(manager.clerkUserId, "GET", "/pulse");
    assert.equal(managerPulse.status, 200);
    const closureAlerts = managerPulse.body.filter((message: any) => message.roomClosureId === closureId);
    assert.equal(closureAlerts.length, 1);
    assert.equal(closureAlerts[0].audience, "managers");
    assert.match(closureAlerts[0].body, /3 nicht stornierte Kurse betroffen/);
    const pulseCountAfterCreation = managerPulse.body.length;
    const missingAssetClosure = await api(manager.clerkUserId, "POST", `/studios/${studio.id}/closures`, {
      roomName: "Unregistered room",
      fromDate: "2026-10-15",
      toDate: "2026-10-30",
      reason: "Maintenance",
      responsible: "Facilities",
    });
    assert.equal(missingAssetClosure.status, 404);
    const overlappingClosure = await api(manager.clerkUserId, "POST", `/studios/${studio.id}/closures`, {
      roomName: "Room A",
      fromDate: "2026-10-30",
      toDate: "2026-10-31",
      reason: "Duplicate form submission",
      responsible: "Facilities",
    });
    assert.equal(overlappingClosure.status, 409);
    const pulseAfterRejectedClosures = await api(manager.clerkUserId, "GET", "/pulse");
    assert.equal(pulseAfterRejectedClosures.body.length, pulseCountAfterCreation);
    assert.equal(
      pulseAfterRejectedClosures.body.filter((message: any) => message.roomClosureId === closureId).length,
      1,
      "rejected closure requests must not create extra Pulse alerts",
    );
    const listedClosures = await api(manager.clerkUserId, "GET", `/studios/${studio.id}/closures`);
    assert.equal(listedClosures.body.length, 2, "only successful closure and seeded room block exist");
    const employeePulse = await api(employee.clerkUserId, "GET", "/pulse");
    assert.equal(employeePulse.status, 200);
    assert.equal(employeePulse.body.some((message: any) => message.roomClosureId === closureId), false);
    const otherManagerPulse = await api(otherManager.clerkUserId, "GET", "/pulse");
    assert.equal(otherManagerPulse.status, 200);
    assert.equal(otherManagerPulse.body.some((message: any) => message.roomClosureId === closureId), false);

    const affectedResponse = await api(
      manager.clerkUserId,
      "GET",
      `/studios/${studio.id}/closures/${closureId}/courses`,
    );
    assert.equal(affectedResponse.status, 200);
    assert.deepEqual(
      affectedResponse.body.map((course: any) => course.title).sort(),
      matchingCourseSpecs.map(({ title }) => title).sort(),
    );
    const courseOn18 = affectedResponse.body.find((course: any) => course.title === "Course October 18");
    assert.ok(courseOn18.alternativeRooms.includes("Room Free"));
    assert.equal(courseOn18.alternativeRooms.includes("Room Blocked"), false);
    assert.equal(courseOn18.alternativeRooms.includes("Room Overlap"), false);

    const relocation = await api(
      manager.clerkUserId,
      "POST",
      `/courses/${matchingCourses[0].id}/closure-resolution`,
      {
        closureId,
        action: "relocate",
        room: "Room Free",
        channel: "in_app",
        idempotencyKey: `closure-relocate-${suffix}`,
      },
    );
    assert.equal(relocation.status, 200, JSON.stringify(relocation.body));
    assert.equal(relocation.body.notifications.length, 1);
    assert.equal(relocation.body.notifications[0].memberId, members[0].id);
    assert.equal(relocation.body.notifications[0].status, "created");

    const cancellation = await api(
      manager.clerkUserId,
      "POST",
      `/courses/${matchingCourses[1].id}/closure-resolution`,
      {
        closureId,
        action: "cancel",
        channel: "in_app",
        idempotencyKey: `closure-cancel-${suffix}`,
      },
    );
    assert.equal(cancellation.status, 200, JSON.stringify(cancellation.body));
    assert.equal(cancellation.body.notifications.length, 1);
    assert.equal(cancellation.body.notifications[0].memberId, members[1].id);
    assert.equal(cancellation.body.notifications[0].status, "created");

    const [relocatedCourse] = await db.select().from(coursesTable)
      .where(eq(coursesTable.id, matchingCourses[0].id));
    assert.equal(relocatedCourse.room, "Room Free");
    assert.equal(relocatedCourse.revision, 2);
    const relocatedDeliveries = await db.select().from(courseEditPushDeliveriesTable)
      .where(eq(courseEditPushDeliveriesTable.courseId, matchingCourses[0].id));
    assert.equal(relocatedDeliveries.length, 3);
    assert.ok(relocatedDeliveries.every((delivery) => delivery.status === "skipped"));
    assert.ok(relocatedDeliveries.every((delivery) => delivery.claimToken === null));
    const [cancelledCourse] = await db.select().from(coursesTable)
      .where(eq(coursesTable.id, matchingCourses[1].id));
    assert.equal(cancelledCourse.status, "cancelled");
    assert.equal(cancelledCourse.revision, 2);
    const cancelledDeliveries = await db.select().from(courseEditPushDeliveriesTable)
      .where(eq(courseEditPushDeliveriesTable.courseId, matchingCourses[1].id));
    assert.equal(cancelledDeliveries.length, 3);
    assert.ok(cancelledDeliveries.every((delivery) => delivery.status === "skipped" && delivery.claimToken === null));
    const cancellationNotices = await db.select().from(memberNotificationsTable).where(and(
      eq(memberNotificationsTable.courseId, matchingCourses[1].id),
      eq(memberNotificationsTable.memberId, members[1].id),
    ));
    assert.equal(cancellationNotices.length, 1);
    assert.equal(cancellationNotices[0].title, "Dein Kurs wurde storniert");
    const relocationNotices = await db.select().from(memberNotificationsTable).where(and(
      eq(memberNotificationsTable.courseId, matchingCourses[0].id),
      eq(memberNotificationsTable.memberId, members[0].id),
    ));
    assert.equal(relocationNotices.length, 1);
    assert.equal(relocationNotices[0].title, "Der Kursraum wurde geändert");
    assert.match(relocationNotices[0].body, /Room Free/);

    const bookingAfterCancellation = await api(
      manager.clerkUserId,
      "POST",
      `/courses/${matchingCourses[1].id}/bookings`,
      { memberId: members[2].id },
    );
    assert.equal(bookingAfterCancellation.status, 409);
    assert.match(bookingAfterCancellation.body.error, /nicht mehr gebucht werden/);
  } finally {
    if (server) {
      server.close();
      await once(server, "close");
    }
    if (organizationId !== undefined) {
      await db.transaction(async (tx) => {
        const studios = await tx.select({ id: studiosTable.id }).from(studiosTable)
          .where(eq(studiosTable.organizationId, organizationId!));
        const studioIds = studios.map(({ id }) => id);
        if (studioIds.length) {
          const closures = await tx.select({ id: roomClosuresTable.id }).from(roomClosuresTable)
            .where(inArray(roomClosuresTable.studioId, studioIds));
          const closureIds = closures.map(({ id }) => id);
          if (closureIds.length) {
            const resolutions = await tx.select({ id: courseClosureResolutionsTable.id })
              .from(courseClosureResolutionsTable)
              .where(inArray(courseClosureResolutionsTable.closureId, closureIds));
            const resolutionIds = resolutions.map(({ id }) => id);
            if (resolutionIds.length) {
              await tx.delete(closureEmailDeliveriesTable)
                .where(inArray(closureEmailDeliveriesTable.resolutionId, resolutionIds));
              await tx.delete(courseClosureResolutionsTable)
                .where(inArray(courseClosureResolutionsTable.id, resolutionIds));
            }
          }
        }
        await tx.delete(organizationsTable).where(eq(organizationsTable.id, organizationId!));
      });
    }
  }
});