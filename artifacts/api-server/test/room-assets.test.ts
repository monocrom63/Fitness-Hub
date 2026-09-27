import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  closureEmailDeliveriesTable,
  closurePushDeliveriesTable,
  courseBookingsTable,
  courseClosureResolutionsTable,
  coursesTable,
  db,
  memberNotificationsTable,
  memberPushSubscriptionsTable,
  organizationsTable,
  roomClosuresTable,
  roomsTable,
  staffTable,
  studiosTable,
  membersTable,
} from "@workspace/db";
import {
  claimResolutionEmailDeliveries,
  closureEmailSender,
  getResolutionEmailStatuses,
} from "../src/lib/closure-email";
import { listClosureResolutionsForStudio } from "../src/lib/closure-resolutions";
import {
  buildClosurePushDeliveryTargets,
  closurePushReadiness,
  processResolutionPushDeliveries,
} from "../src/lib/closure-push";
import { canAccessStudio, getStaffContext } from "../src/lib/fiudia-access";
import { WAITLIST_EMAIL_SENDER } from "../src/lib/waitlist-email";
import {
  hasOverlappingLiveCourse,
  invalidateCoursePromotionNotices,
} from "../src/lib/room-closures";

test("room asset scope is studio-specific and concurrent resolution writes are idempotent", async () => {
  const suffix = randomUUID();
  let organizationId: number | undefined;
  try {
    const [organization] = await db.insert(organizationsTable)
      .values({ name: `Room test ${suffix}` }).returning();
    organizationId = organization.id;
    const [studio, otherStudio] = await db.insert(studiosTable).values([
      { organizationId, name: "Room test studio", city: "Berlin" },
      { organizationId, name: "Other room test studio", city: "Berlin" },
    ]).returning();
    const [staff] = await db.insert(staffTable).values({
      clerkUserId: `room-test-${suffix}`,
      organizationId,
      studioId: studio.id,
      fullName: "Room Manager",
      email: `room-manager-${suffix}@example.invalid`,
      role: "studio_manager",
    }).returning();
    const [secondManager] = await db.insert(staffTable).values({
      clerkUserId: `room-test-second-${suffix}`,
      organizationId,
      studioId: studio.id,
      fullName: "Second Room Manager",
      email: `room-manager-second-${suffix}@example.invalid`,
      role: "studio_manager",
    }).returning();

    const [roomInStudio, roomInOtherStudio] = await db.insert(roomsTable).values([
      { studioId: studio.id, name: "Studio A" },
      { studioId: otherStudio.id, name: "Studio A" },
    ]).returning();
    assert.equal(roomInStudio.name, roomInOtherStudio.name);
    assert.notEqual(roomInStudio.studioId, roomInOtherStudio.studioId);
    const managerContext = await getStaffContext(staff.clerkUserId);
    const secondManagerContext = await getStaffContext(secondManager.clerkUserId);
    assert.ok(managerContext);
    assert.ok(secondManagerContext);
    assert.equal(await canAccessStudio(managerContext, studio.id), true);
    assert.equal(await canAccessStudio(managerContext, otherStudio.id), false);
    await assert.rejects(
      db.insert(roomsTable).values({ studioId: studio.id, name: "Studio A" }),
      (error: unknown) => {
        const cause = (error as { cause?: { message?: string } }).cause;
        return cause?.message?.includes("fiudia_room_studio_name") === true;
      },
    );
    const studioRooms = await db.select().from(roomsTable).where(eq(roomsTable.studioId, studio.id));
    assert.deepEqual(studioRooms.map(({ name }) => name), ["Studio A"]);

    const [course] = await db.insert(coursesTable).values({
      studioId: studio.id,
      title: "Room closure test",
      instructor: "Trainer",
      startsAt: new Date("2030-04-10T09:00:00Z"),
      endsAt: new Date("2030-04-10T10:00:00Z"),
      capacity: 10,
      room: roomInStudio.name,
    }).returning();
    assert.equal(await hasOverlappingLiveCourse(
      studio.id,
      roomInStudio.name,
      new Date("2030-04-10T09:30:00Z"),
      new Date("2030-04-10T10:30:00Z"),
    ), true);
    assert.equal(await hasOverlappingLiveCourse(
      studio.id,
      roomInStudio.name,
      new Date("2030-04-10T10:00:00Z"),
      new Date("2030-04-10T11:00:00Z"),
    ), false, "intervals touching at the course end are not overlapping");
    await db.update(coursesTable).set({ status: "cancelled" }).where(eq(coursesTable.id, course.id));
    assert.equal(await hasOverlappingLiveCourse(
      studio.id,
      roomInStudio.name,
      new Date("2030-04-10T09:30:00Z"),
      new Date("2030-04-10T10:30:00Z"),
    ), false, "cancelled courses do not block the room");
    await db.update(coursesTable).set({ status: "scheduled" }).where(eq(coursesTable.id, course.id));
    const [closure] = await db.insert(roomClosuresTable).values({
      studioId: studio.id,
      roomName: roomInStudio.name,
      fromDate: "2030-04-10",
      toDate: "2030-04-10",
      reason: "Maintenance",
      responsible: "Facilities",
      createdByStaffId: staff.id,
    }).returning();
    const [otherClosure] = await db.insert(roomClosuresTable).values({
      studioId: studio.id,
      roomName: roomInStudio.name,
      fromDate: "2030-04-10",
      toDate: "2030-04-10",
      reason: "Separate maintenance event",
      responsible: "Facilities",
      createdByStaffId: staff.id,
    }).returning();

    const concurrentWrites = await Promise.allSettled([
      db.insert(courseClosureResolutionsTable).values({
        courseId: course.id,
        closureId: closure.id,
        action: "cancel",
        channel: "in_app",
        idempotencyKey: `room-resolve-${suffix}-one`,
      }).returning(),
      db.insert(courseClosureResolutionsTable).values({
        courseId: course.id,
        closureId: closure.id,
        action: "cancel",
        channel: "in_app",
        idempotencyKey: `room-resolve-${suffix}-two`,
      }).returning(),
    ]);
    assert.equal(concurrentWrites.filter((write) => write.status === "fulfilled").length, 1);
    assert.equal(concurrentWrites.filter((write) => write.status === "rejected").length, 1);
    const persisted = await db.select().from(courseClosureResolutionsTable).where(and(
      eq(courseClosureResolutionsTable.courseId, course.id),
      eq(courseClosureResolutionsTable.closureId, closure.id),
    ));
    assert.equal(persisted.length, 1);
    await db.insert(courseClosureResolutionsTable).values({
      courseId: course.id,
      closureId: otherClosure.id,
      action: "cancel",
      channel: "push",
      idempotencyKey: `room-resolve-${suffix}-later-closure`,
    });
    const courseResolutions = await db.select().from(courseClosureResolutionsTable)
      .where(eq(courseClosureResolutionsTable.courseId, course.id));
    assert.equal(courseResolutions.length, 2, "a later distinct closure for a course remains resolvable");
    await assert.rejects(
      db.delete(roomClosuresTable).where(eq(roomClosuresTable.id, closure.id)),
      (error: unknown) => (error as { cause?: { message?: string } }).cause?.message?.includes("foreign key") === true,
      "resolution audit rows prevent closure deletion even if a caller bypasses the route",
    );

    const [member] = await db.insert(membersTable).values({
      studioId: studio.id,
      fullName: "Email retry member",
      email: `retry-${suffix}@example.invalid`,
      membershipType: "Basic",
    }).returning();
    const [booking] = await db.insert(courseBookingsTable).values({
      courseId: course.id,
      memberId: member.id,
      status: "confirmed",
    }).returning();
    const [memberWithoutPush] = await db.insert(membersTable).values({
      studioId: studio.id,
      fullName: "No push subscription member",
      email: `no-push-${suffix}@example.invalid`,
      membershipType: "Basic",
    }).returning();
    const [bookingWithoutPush] = await db.insert(courseBookingsTable).values({
      courseId: course.id,
      memberId: memberWithoutPush.id,
      status: "waitlisted",
    }).returning();
    const [promotionNotice] = await db.insert(memberNotificationsTable).values({
      bookingId: booking.id,
      memberId: member.id,
      courseId: course.id,
      title: "Dein Kursplatz ist bestätigt",
      body: "Promoted from waitlist.",
      emailRequested: 1,
    }).returning();
    await db.transaction((tx) =>
      invalidateCoursePromotionNotices(course.id, course.title, tx),
    );
    const [invalidatedNotice] = await db.select().from(memberNotificationsTable)
      .where(eq(memberNotificationsTable.id, promotionNotice.id));
    assert.equal(invalidatedNotice.emailRequested, 0);
    assert.equal(invalidatedNotice.title, "Kursplatzbestätigung ungültig");
    const [emailResolution] = await db.select().from(courseClosureResolutionsTable)
      .where(and(
        eq(courseClosureResolutionsTable.courseId, course.id),
        eq(courseClosureResolutionsTable.closureId, closure.id),
      ));
    const [pushResolution] = await db.select().from(courseClosureResolutionsTable)
      .where(eq(courseClosureResolutionsTable.closureId, otherClosure.id));
    const [delivery] = await db.insert(closureEmailDeliveriesTable).values({
      resolutionId: emailResolution.id,
      bookingId: booking.id,
      memberId: member.id,
      email: member.email,
      status: "failed",
      error: "Provider unavailable",
      attemptCount: 1,
    }).returning();
    await db.insert(memberPushSubscriptionsTable).values({
      subscriptionId: randomUUID(),
      memberId: member.id,
    });
    const subscriptionId = (await db.select({ subscriptionId: memberPushSubscriptionsTable.subscriptionId })
      .from(memberPushSubscriptionsTable).where(eq(memberPushSubscriptionsTable.memberId, member.id)))[0].subscriptionId;
    const idempotencyKey = randomUUID();
    const pushTargets = buildClosurePushDeliveryTargets(
      [
        { id: booking.id, memberId: member.id },
        { id: bookingWithoutPush.id, memberId: memberWithoutPush.id },
      ],
      [{ memberId: member.id, subscriptionId }],
    );
    assert.equal(pushTargets.length, 2);
    assert.equal(pushTargets.filter(({ status }) => status === "pending").length, 1);
    assert.equal(pushTargets.filter(({ status }) => status === "skipped").length, 1);
    assert.deepEqual(buildClosurePushDeliveryTargets([], []), [], "a course with no bookings has no push deliveries");
    await db.insert(closurePushDeliveriesTable).values(pushTargets.map((target) => ({
      resolutionId: pushResolution.id,
      bookingId: target.bookingId,
      memberId: target.memberId,
      subscriptionId: target.subscriptionId,
      idempotencyKey: target.status === "pending" ? idempotencyKey : randomUUID(),
      status: target.status,
      error: target.error,
    })));
    await db.insert(closurePushDeliveriesTable).values({
      resolutionId: pushResolution.id,
      bookingId: bookingWithoutPush.id,
      memberId: memberWithoutPush.id,
      subscriptionId: null,
      idempotencyKey: randomUUID(),
      status: "pending",
    });
    let providerCalls = 0;
    const requestBodies: unknown[] = [];
    const mockProxy = async (_path: string, options?: { method?: string; body?: unknown }) => {
      providerCalls += 1;
      assert.equal(options?.method, "POST");
      requestBodies.push(options?.body);
      return new Response(JSON.stringify(providerCalls === 1 ? {} : { id: "onesignal-notification-id" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const firstPushAttempt = await processResolutionPushDeliveries(pushResolution.id, mockProxy);
    assert.equal(firstPushAttempt.find(({ memberId }) => memberId === member.id)?.status, "failed", "HTTP 200 without provider ID is not a confirmed send");
    assert.equal(firstPushAttempt.find(({ memberId }) => memberId === memberWithoutPush.id)?.status, "skipped");
    assert.match(firstPushAttempt.find(({ memberId }) => memberId === memberWithoutPush.id)?.error ?? "", /In-App-Fallback/);
    assert.equal(firstPushAttempt.filter(({ memberId, status }) => memberId === memberWithoutPush.id && status === "pending").length, 1);
    const secondPushAttempt = await processResolutionPushDeliveries(pushResolution.id, mockProxy);
    assert.equal(secondPushAttempt.find(({ memberId }) => memberId === member.id)?.status, "sent");
    assert.equal(secondPushAttempt.find(({ memberId }) => memberId === memberWithoutPush.id)?.status, "skipped");
    assert.equal(secondPushAttempt.filter(({ memberId, status }) => memberId === memberWithoutPush.id && status === "pending").length, 1);
    assert.equal(providerCalls, 2);
    assert.equal((requestBodies[0] as any).idempotency_key, idempotencyKey);
    assert.deepEqual((requestBodies[0] as any).include_subscription_ids, [subscriptionId]);
    assert.equal((requestBodies[0] as any).target_channel, "push");
    assert.equal((requestBodies[0] as any).app_id, "c1a30beb-bc79-45f6-9cdd-275e663dbcd6");
    assert.deepEqual((requestBodies[0] as any).data, {
      courseId: pushResolution.courseId,
      memberId: member.id,
    });
    assert.deepEqual(requestBodies[1], requestBodies[0], "the stable payload and provider idempotency key are reused");
    const repeatPushAttempt = await processResolutionPushDeliveries(pushResolution.id, mockProxy);
    assert.equal(repeatPushAttempt[0].status, "sent");
    assert.equal(providerCalls, 2, "successful deliveries are not sent again on retry");
    const withdrawnSubscriptionId = randomUUID();
    await db.insert(closurePushDeliveriesTable).values({
      resolutionId: pushResolution.id,
      bookingId: bookingWithoutPush.id,
      memberId: memberWithoutPush.id,
      subscriptionId: withdrawnSubscriptionId,
      idempotencyKey: randomUUID(),
      status: "pending",
    });
    const afterWithdrawal = await processResolutionPushDeliveries(pushResolution.id, mockProxy);
    assert.equal(afterWithdrawal.find((item) => item.memberId === memberWithoutPush.id && item.status === "skipped" && item.attemptCount === 1)?.error?.includes("abgemeldet"), true);
    assert.equal(providerCalls, 2, "unlinked browser subscriptions are never sent to OneSignal");
    const pushResolutionReport = await listClosureResolutionsForStudio(studio.id, otherClosure.id);
    assert.equal(pushResolutionReport[0].deliveryCounts.sent, 1);
    assert.equal(pushResolutionReport[0].deliveries[0].status, "sent");
    assert.equal("subscriptionId" in pushResolutionReport[0].deliveries[0], false);
    const ready = await closurePushReadiness(async (path, options) => {
      assert.match(path, /^\/notifications\?app_id=c1a30beb-bc79-45f6-9cdd-275e663dbcd6&limit=1&offset=0$/);
      assert.equal(options?.method, "GET");
      return new Response("{}", { status: 200 });
    });
    assert.equal(ready, null);
    const unauthorized = await closurePushReadiness(async () => new Response("unauthorized", { status: 401 }));
    assert.match(unauthorized ?? "", /OneSignal-Verbindung/);
    const persistedResolutionReport = await listClosureResolutionsForStudio(studio.id, closure.id);
    assert.equal(persistedResolutionReport.length, 1);
    assert.equal(persistedResolutionReport[0].deliveryCounts.failed, 1);
    assert.equal(persistedResolutionReport[0].deliveries[0].error, "Provider unavailable");
    assert.equal("email" in persistedResolutionReport[0].deliveries[0], false);
    assert.equal(closureEmailSender(undefined), WAITLIST_EMAIL_SENDER);
    assert.equal(closureEmailSender("custom@fiudia.com"), "custom@fiudia.com");
    const emailReport = await getResolutionEmailStatuses(emailResolution.id);
    assert.equal(emailReport[0].status, "failed");
    assert.equal("email" in emailReport[0], false);
    assert.equal(await canAccessStudio(secondManagerContext, studio.id), true);
    const secondManagerReport = await listClosureResolutionsForStudio(studio.id, closure.id);
    assert.equal(secondManagerReport[0].deliveries[0].status, "failed");
    assert.deepEqual(
      await listClosureResolutionsForStudio(otherStudio.id, closure.id),
      [],
      "a manager's other studio cannot see resolutions for this closure",
    );
    const claims = await Promise.all([
      claimResolutionEmailDeliveries(emailResolution.id),
      claimResolutionEmailDeliveries(emailResolution.id),
    ]);
    const allClaims = claims.flat();
    assert.equal(allClaims.length, 1, "parallel retry requests must not claim the same delivery twice");
    assert.equal(allClaims[0].id, delivery.id);
    const [claimedRow] = await db.select().from(closureEmailDeliveriesTable)
      .where(eq(closureEmailDeliveriesTable.id, delivery.id));
    assert.equal(claimedRow.status, "sending");
    assert.equal(claimedRow.attemptCount, 2, "retry attempt is durably counted before network I/O");
    await db.update(closureEmailDeliveriesTable).set({
      claimedAt: new Date(Date.now() - 6 * 60 * 1000),
    }).where(eq(closureEmailDeliveriesTable.id, delivery.id));
    const recovered = await claimResolutionEmailDeliveries(emailResolution.id);
    assert.equal(recovered.length, 1, "expired claims are eligible for recovery after a crashed request");
    const [recoveredRow] = await db.select().from(closureEmailDeliveriesTable)
      .where(eq(closureEmailDeliveriesTable.id, delivery.id));
    assert.equal(recoveredRow.attemptCount, 3);
  } finally {
    if (organizationId !== undefined) {
      await db.transaction(async (tx) => {
        const testStudios = await tx.select({ id: studiosTable.id }).from(studiosTable)
          .where(eq(studiosTable.organizationId, organizationId!));
        const studioIds = testStudios.map(({ id }) => id);
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
              await tx.delete(closurePushDeliveriesTable)
                .where(inArray(closurePushDeliveriesTable.resolutionId, resolutionIds));
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