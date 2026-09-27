import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  courseBookingsTable, coursesTable, db, memberNotificationsTable,
  memberPushSubscriptionsTable, membersTable, organizationsTable,
  pulseMessagesTable, staffTable, studiosTable, trainerAbsenceCoursesTable,
  trainerAbsencePushDeliveriesTable, trainerAbsencesTable,
} from "@workspace/db";
import { processTrainerAbsencePush, type TrainerPushProxy } from "../src/lib/trainer-absence-push";
import { createTrainerAbsencesRouter } from "../src/routes/trainer-absences";

function futureBerlinDay() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(Date.now() + 14 * 86400000));
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

test("manager records an absence, resolves all affected courses and notifies members without disclosing sickness", async () => {
  const suffix = randomUUID();
  let organizationId: number | undefined;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  const sends: Array<{ body: any }> = [];
  const proxy: TrainerPushProxy = async (_path, options) => {
    sends.push({ body: options?.body });
    if (sends.length === 1) return new Response(JSON.stringify({ message: "Simulated provider outage" }), {
      status: 503, headers: { "content-type": "application/json" },
    });
    return new Response(JSON.stringify({ id: `mock-${sends.length}` }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    const [organization] = await db.insert(organizationsTable)
      .values({ name: `Trainer absence ${suffix}` }).returning();
    organizationId = organization.id;
    const [studio, otherStudio] = await db.insert(studiosTable).values([
      { organizationId, name: `Studio ${suffix}`, city: "Berlin" },
      { organizationId, name: `Other ${suffix}`, city: "Berlin" },
    ]).returning();
    const [manager, employee, otherManager, secondManager] = await db.insert(staffTable).values([
      { clerkUserId: `absence-manager-${suffix}`, organizationId, studioId: studio.id, fullName: "Manager", email: `manager-${suffix}@example.invalid`, role: "studio_manager" },
      { clerkUserId: `absence-employee-${suffix}`, organizationId, studioId: studio.id, fullName: "Employee", email: `employee-${suffix}@example.invalid`, role: "studio_employee" },
      { clerkUserId: `absence-other-${suffix}`, organizationId, studioId: otherStudio.id, fullName: "Other manager", email: `other-${suffix}@example.invalid`, role: "studio_manager" },
      { clerkUserId: `absence-second-${suffix}`, organizationId, studioId: studio.id, fullName: "Second manager", email: `second-${suffix}@example.invalid`, role: "studio_manager" },
    ]).returning();
    const day = futureBerlinDay();
    const slot = (hour: number, minute = 0) => new Date(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`);
    const [morning, midday, evening] = await db.insert(coursesTable).values([
      { studioId: studio.id, title: "Pilates", instructor: "Mike", startsAt: slot(8), endsAt: slot(9), room: "A", capacity: 10, enrolled: 1 },
      { studioId: studio.id, title: "Mobility", instructor: "Mike", startsAt: slot(12), endsAt: slot(13), room: "A", capacity: 10, enrolled: 1 },
      { studioId: studio.id, title: "Strength", instructor: "Mike", startsAt: slot(16), endsAt: slot(17), room: "A", capacity: 10, enrolled: 1 },
      { studioId: studio.id, title: "Yoga", instructor: "Anna", startsAt: slot(8), endsAt: slot(9, 30), room: "B", capacity: 10 },
      { studioId: studio.id, title: "Sarah's class", instructor: "Sarah", startsAt: slot(10), endsAt: slot(11), room: "C", capacity: 10 },
      { studioId: studio.id, title: "Leo's class", instructor: "Leo", startsAt: slot(19), endsAt: slot(20), room: "D", capacity: 10 },
      { studioId: studio.id, title: "Dana's class", instructor: "Dana", startsAt: slot(19), endsAt: slot(20), room: "E", capacity: 10 },
    ]).returning();
    const members = await db.insert(membersTable).values([0, 1, 2].map((index) => ({
      studioId: studio.id, fullName: `Member ${index}`,
      email: `member-${index}-${suffix}@example.invalid`, membershipType: "Basic", status: "active",
    }))).returning();
    await db.insert(courseBookingsTable).values([morning, midday, evening].map((course, index) => ({
      courseId: course.id, memberId: members[index].id, status: "confirmed",
    })));
    await db.insert(memberPushSubscriptionsTable).values({
      memberId: members[0].id, subscriptionId: `test-${suffix}`,
    });
    await db.insert(trainerAbsencesTable).values({
      studioId: studio.id, instructor: "Leo", fromDate: day, toDate: day,
      createdByStaffId: manager.id,
    });

    const app = express();
    app.use(express.json());
    app.use("/api", createTrainerAbsencesRouter({
      userIdFromRequest: (req) => req.header("x-test-user") ?? null,
      processPush: (id) => processTrainerAbsencePush(id, proxy),
    }));
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    async function api(user: string, method: string, path: string, body?: unknown) {
      const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
        method, headers: { "x-test-user": user, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as any };
    }
    const input = { studioId: studio.id, instructor: "Mike", fromDate: day, toDate: day };
    assert.equal((await api(employee.clerkUserId, "POST", "/trainer-absences", input)).status, 403);
    assert.equal((await api(otherManager.clerkUserId, "POST", "/trainer-absences", input)).status, 403);
    const created = await api(manager.clerkUserId, "POST", "/trainer-absences", input);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.courses.length, 3);
    assert.equal((await api(manager.clerkUserId, "POST", "/trainer-absences", input)).status, 409);
    assert.deepEqual(await api(otherManager.clerkUserId, "GET", "/trainer-absences"), { status: 200, body: [] });
    const [alert] = await db.select().from(pulseMessagesTable)
      .where(eq(pulseMessagesTable.id, (await db.select({ id: trainerAbsencesTable.pulseMessageId })
        .from(trainerAbsencesTable).where(eq(trainerAbsencesTable.id, created.body.id)))[0].id!));
    assert.equal(alert.audience, "managers");
    assert.equal(alert.priority, "urgent");
    assert.match(alert.body, /3 Kurse ohne Trainer/);

    const prefix = (courseId: number) =>
      `/trainer-absences/${created.body.id}/courses/${courseId}`;
    const candidateResult = await api(manager.clerkUserId, "GET", `${prefix(morning.id)}/candidates`);
    assert.equal(candidateResult.status, 200);
    const candidate = (name: string) => candidateResult.body.find((item: any) => item.name === name);
    assert.equal(candidate("Anna").available, false);
    assert.equal(candidate("Sarah").available, true);
    assert.equal(candidate("Leo").available, false);
    assert.equal((await api(manager.clerkUserId, "POST", `${prefix(morning.id)}/request`,
      { candidateName: "Anna" })).status, 409);
    assert.equal((await api(manager.clerkUserId, "POST", `${prefix(morning.id)}/request`,
      { candidateName: "Sarah" })).status, 200);
    assert.equal((await api(secondManager.clerkUserId, "POST", `${prefix(morning.id)}/request`,
      { candidateName: "Dana" })).status, 200);
    const staleConfirmation = await api(manager.clerkUserId, "POST", `${prefix(morning.id)}/resolve`,
      { action: "replace", candidateName: "Sarah" });
    assert.equal(staleConfirmation.status, 409);
    assert.match(staleConfirmation.body.error, /inzwischen geändert/);
    assert.equal(sends.length, 0);
    assert.equal((await api(secondManager.clerkUserId, "POST", `${prefix(morning.id)}/request`,
      { candidateName: "Sarah" })).status, 200);
    const replaced = await api(manager.clerkUserId, "POST", `${prefix(morning.id)}/resolve`,
      { action: "replace", candidateName: "Sarah" });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.equal(replaced.body.instructor, "Sarah");
    assert.equal(replaced.body.pushFailed, 1);
    assert.equal(sends.length, 1);
    assert.doesNotMatch(JSON.stringify(sends[0]), /krank|Mike|Abwesenheit/i);
    const [noticeAfterFailure] = await db.select().from(memberNotificationsTable)
      .where(eq(memberNotificationsTable.courseId, morning.id));
    assert.ok(noticeAfterFailure, "In-App notification survives provider failure");
    const retried = await api(manager.clerkUserId, "POST", `${prefix(morning.id)}/push/retry`);
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.pushSent, 1);
    assert.equal(sends.length, 2);
    assert.match(sends[0].body.idempotency_key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(sends[0].body.idempotency_key, sends[1].body.idempotency_key);
    assert.equal((await api(manager.clerkUserId, "POST", `${prefix(morning.id)}/resolve`,
      { action: "replace", candidateName: "Sarah" })).status, 409);
    await processTrainerAbsencePush(replaced.body.id, proxy);
    assert.equal(sends.length, 2, "successful push is never resent");

    const cancelled = await api(manager.clerkUserId, "POST", `${prefix(midday.id)}/resolve`, { action: "cancel" });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const [cancelledBooking] = await db.select().from(courseBookingsTable)
      .where(eq(courseBookingsTable.courseId, midday.id));
    assert.equal(cancelledBooking.status, "cancelled");
    assert.equal((await db.select().from(coursesTable).where(eq(coursesTable.id, midday.id)))[0].status, "cancelled");
    const external = await api(manager.clerkUserId, "POST", `${prefix(evening.id)}/resolve`,
      { action: "external", externalName: "Externe Vertretung" });
    assert.equal(external.status, 200, JSON.stringify(external.body));
    assert.equal(external.body.instructor, "Externe Vertretung");
    const notices = await db.select().from(memberNotificationsTable)
      .where(inArray(memberNotificationsTable.courseId, [morning.id, midday.id, evening.id]));
    assert.equal(notices.length, 3);
    for (const notice of notices) assert.doesNotMatch(`${notice.title} ${notice.body}`, /krank|Mike|Abwesenheit/i);
    assert.match(notices.find((notice) => notice.courseId === midday.id)!.body, /storniert/);
    const [resolvedAlert] = await db.select().from(pulseMessagesTable).where(eq(pulseMessagesTable.id, alert.id));
    assert.ok(resolvedAlert.retractedAt, "urgent manager alert is retired once all courses are resolved");
  } finally {
    if (server) { server.close(); await once(server, "close"); }
    if (organizationId !== undefined) {
      await db.transaction(async (tx) => {
        const studioIds = (await tx.select({ id: studiosTable.id }).from(studiosTable)
          .where(eq(studiosTable.organizationId, organizationId!))).map((item) => item.id);
        const absenceIds = (await tx.select({ id: trainerAbsencesTable.id }).from(trainerAbsencesTable)
          .where(inArray(trainerAbsencesTable.studioId, studioIds))).map((item) => item.id);
        if (absenceIds.length) {
          const decisionIds = (await tx.select({ id: trainerAbsenceCoursesTable.id }).from(trainerAbsenceCoursesTable)
            .where(inArray(trainerAbsenceCoursesTable.absenceId, absenceIds))).map((item) => item.id);
          if (decisionIds.length) {
            await tx.delete(trainerAbsencePushDeliveriesTable)
              .where(inArray(trainerAbsencePushDeliveriesTable.absenceCourseId, decisionIds));
            await tx.delete(trainerAbsenceCoursesTable)
              .where(inArray(trainerAbsenceCoursesTable.id, decisionIds));
          }
          await tx.delete(trainerAbsencesTable).where(inArray(trainerAbsencesTable.id, absenceIds));
        }
        await tx.delete(organizationsTable).where(eq(organizationsTable.id, organizationId!));
      });
    }
  }
});