import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  courseBookingsTable, courseClosureResolutionsTable, coursesTable, db, memberNotificationsTable,
  memberPushSubscriptionsTable, membersTable, organizationsTable,
  pulseMessagesTable, roomClosuresTable, staffTable, studiosTable, trainerAbsenceCoursesTable,
  trainerAbsencePushDeliveriesTable, trainerAbsencesTable,
} from "@workspace/db";
import { processTrainerAbsencePush, type TrainerPushProxy } from "../src/lib/trainer-absence-push";
import { createTrainerAbsencesRouter } from "../src/routes/trainer-absences";
import portalRouter from "../src/routes/portal";
import roomAssetsRouter from "../src/routes/room-assets";

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
  let foreignOrganizationId: number | undefined;
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
    const [foreignOrganization] = await db.insert(organizationsTable)
      .values({ name: `Foreign trainer absence ${suffix}` }).returning();
    foreignOrganizationId = foreignOrganization.id;
    const [foreignStudio] = await db.insert(studiosTable).values({
      organizationId: foreignOrganization.id, name: `Foreign ${suffix}`, city: "Cologne",
    }).returning();
    const [studio, otherStudio] = await db.insert(studiosTable).values([
      { organizationId, name: `Studio ${suffix}`, city: "Berlin" },
      { organizationId, name: `Other ${suffix}`, city: "Berlin" },
    ]).returning();
    const [manager, employee, otherManager, secondManager, districtManager] = await db.insert(staffTable).values([
      { clerkUserId: `absence-manager-${suffix}`, organizationId, studioId: studio.id, fullName: "Manager", email: `manager-${suffix}@example.invalid`, role: "studio_manager" },
      { clerkUserId: `absence-employee-${suffix}`, organizationId, studioId: studio.id, fullName: "Employee", email: `employee-${suffix}@example.invalid`, role: "studio_employee" },
      { clerkUserId: `absence-other-${suffix}`, organizationId, studioId: otherStudio.id, fullName: "Other manager", email: `other-${suffix}@example.invalid`, role: "studio_manager" },
      { clerkUserId: `absence-second-${suffix}`, organizationId, studioId: studio.id, fullName: "Second manager", email: `second-${suffix}@example.invalid`, role: "studio_manager" },
      { clerkUserId: `absence-district-${suffix}`, organizationId, studioId: null, fullName: "District manager", email: `district-${suffix}@example.invalid`, role: "district_manager" },
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
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user") ?? null;
      const auth = Object.assign(() => ({ userId, tokenType: "session_token" }), {
        [Symbol.for("@clerk/express.auth")]: true,
      });
      Object.assign(req, { auth });
      next();
    });
    app.use("/api", createTrainerAbsencesRouter({
      userIdFromRequest: (req) => req.header("x-test-user") ?? null,
      processPush: (id) => processTrainerAbsencePush(id, proxy),
    }), portalRouter, roomAssetsRouter);
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
    await db.insert(trainerAbsencesTable).values(Array.from({ length: 51 }, (_, index) => ({
      studioId: otherStudio.id, instructor: `Limit fixture ${index}`, fromDate: day, toDate: day,
      createdByStaffId: otherManager.id,
    })));
    const unfilteredAbsences = await api(districtManager.clerkUserId, "GET", "/trainer-absences");
    assert.equal(unfilteredAbsences.body.length, 50);
    assert.ok(!unfilteredAbsences.body.some((absence: any) => absence.id === created.body.id),
      "the older studio's absence falls outside the organization-wide limit");
    const filteredAbsences = await api(districtManager.clerkUserId, "GET", `/trainer-absences?studioId=${studio.id}`);
    assert.equal(filteredAbsences.status, 200);
    assert.ok(filteredAbsences.body.some((absence: any) => absence.id === created.body.id));
    assert.ok(filteredAbsences.body.every((absence: any) => absence.studioId === studio.id));
    const otherStudioAbsences = await api(districtManager.clerkUserId, "GET",
      `/trainer-absences?studioId=${otherStudio.id}`);
    assert.equal(otherStudioAbsences.body.length, 50);
    assert.ok(otherStudioAbsences.body.every((absence: any) => absence.studioId === otherStudio.id));
    assert.equal((await api(districtManager.clerkUserId, "GET",
      `/trainer-absences?studioId=${foreignStudio.id}`)).status, 403);
    assert.equal((await api(districtManager.clerkUserId, "GET",
      "/trainer-absences?studioId=not-a-number")).status, 400);
    const [alert] = await db.select().from(pulseMessagesTable)
      .where(eq(pulseMessagesTable.id, (await db.select({ id: trainerAbsencesTable.pulseMessageId })
        .from(trainerAbsencesTable).where(eq(trainerAbsencesTable.id, created.body.id)))[0].id!));
    assert.equal(alert.audience, "managers");
    assert.equal(alert.priority, "urgent");
    assert.match(alert.body, /3 Kurse ohne Trainer/);
    const newCourse = (instructor: string, startsAt: Date, endsAt: Date, room = "New Room") => ({
      studioId: studio.id, title: "New class", instructor, startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(), capacity: 10, room,
    });
    const blockedCourse = await api(manager.clerkUserId, "POST", "/courses",
      newCourse("  mIkE  ", slot(14), slot(15)));
    assert.equal(blockedCourse.status, 409, JSON.stringify(blockedCourse.body));
    assert.match(blockedCourse.body.error, /abwesend/);
    const utcMidnight = slot(0);
    const berlinOffsetHours = Number(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23",
    }).format(utcMidnight));
    const berlinMidnight = new Date(utcMidnight.getTime() - berlinOffsetHours * 3600000);
    const minutesFromMidnight = (minutes: number) => new Date(berlinMidnight.getTime() + minutes * 60000);
    const overnightCourse = await api(manager.clerkUserId, "POST", "/courses",
      newCourse("Mike", minutesFromMidnight(-45), minutesFromMidnight(45), "Overnight Room"));
    assert.equal(overnightCourse.status, 409, JSON.stringify(overnightCourse.body));
    assert.match(overnightCourse.body.error, /abwesend/);
    const endedBeforeAbsence = await api(manager.clerkUserId, "POST", "/courses",
      newCourse("Mike", minutesFromMidnight(-60), berlinMidnight, "Previous Day Room"));
    assert.equal(endedBeforeAbsence.status, 201, JSON.stringify(endedBeforeAbsence.body));
    assert.equal((await api(employee.clerkUserId, "POST", "/courses",
      newCourse("Mike", slot(14), slot(15)))).status, 403);
    assert.equal((await api(otherManager.clerkUserId, "POST", "/courses",
      newCourse("Mike", slot(14), slot(15)))).status, 403);
    const unaffectedStudio = await api(otherManager.clerkUserId, "POST", "/courses", {
      ...newCourse("Mike", slot(14), slot(15), "Other Studio Room"), studioId: otherStudio.id,
    });
    assert.equal(unaffectedStudio.status, 201, JSON.stringify(unaffectedStudio.body));
    const availableStudios = await api(districtManager.clerkUserId, "GET", "/studios");
    assert.equal(availableStudios.status, 200);
    assert.deepEqual(availableStudios.body.map((item: any) => item.id).sort((a: number, b: number) => a - b),
      [studio.id, otherStudio.id].sort((a, b) => a - b));
    const studioDraft = { name: "  Studio West  ", city: "  Berlin  ", organizationId: -123 };
    assert.equal((await api("", "POST", "/studios", studioDraft)).status, 401);
    assert.equal((await api(manager.clerkUserId, "POST", "/studios", studioDraft)).status, 403);
    assert.equal((await api(employee.clerkUserId, "POST", "/studios", studioDraft)).status, 403);
    assert.equal((await api(districtManager.clerkUserId, "POST", "/studios",
      { name: "   ", city: "Berlin" })).status, 400);
    const newStudio = await api(districtManager.clerkUserId, "POST", "/studios", studioDraft);
    assert.equal(newStudio.status, 201, JSON.stringify(newStudio.body));
    assert.equal(newStudio.body.name, "Studio West");
    assert.equal(newStudio.body.city, "Berlin");
    const [storedStudio] = await db.select().from(studiosTable).where(eq(studiosTable.id, newStudio.body.id));
    assert.equal(storedStudio.organizationId, organizationId, "organization comes from the signed-in district manager");
    assert.equal((await api(districtManager.clerkUserId, "POST", "/studios",
      { name: "studio west", city: "BERLIN" })).status, 409);
    const simultaneous = await Promise.all([0, 1].map(() =>
      api(districtManager.clerkUserId, "POST", "/studios", { name: "Studio Süd", city: "Potsdam" })));
    assert.deepEqual(simultaneous.map(result => result.status).sort(), [201, 409]);
    const updatedStudios = await api(districtManager.clerkUserId, "GET", "/studios");
    assert.equal(updatedStudios.body.filter((item: any) => item.name === "Studio Süd").length, 1);
    assert.ok(updatedStudios.body.some((item: any) => item.id === newStudio.body.id));
    const managerStudios = await api(manager.clerkUserId, "GET", "/studios");
    assert.ok(!managerStudios.body.some((item: any) => item.id === newStudio.body.id));
    const courseInNewStudio = await api(districtManager.clerkUserId, "POST", "/courses", {
      ...newCourse("Lina", slot(14), slot(15), "New studio room"), studioId: newStudio.body.id,
    });
    assert.equal(courseInNewStudio.status, 201, JSON.stringify(courseInNewStudio.body));
    assert.equal(courseInNewStudio.body.studioName, "Studio West");
    const districtCourse = await api(districtManager.clerkUserId, "POST", "/courses", {
      ...newCourse("Lina", slot(14), slot(15), "District Room"), studioId: otherStudio.id,
    });
    assert.equal(districtCourse.status, 201, JSON.stringify(districtCourse.body));
    assert.equal(districtCourse.body.studioId, otherStudio.id);
    assert.equal(districtCourse.body.studioName, otherStudio.name);
    const districtList = await api(districtManager.clerkUserId, "GET", "/courses");
    assert.equal(districtList.body.find((course: any) => course.id === districtCourse.body.id)?.studioName, otherStudio.name);
    const managerList = await api(manager.clerkUserId, "GET", "/courses");
    assert.ok(!managerList.body.some((course: any) => course.id === districtCourse.body.id));
    const nextDay = (value: Date) => new Date(value.getTime() + 86400000);
    const outsideAbsence = await api(manager.clerkUserId, "POST", "/courses",
      newCourse("  Mike  ", nextDay(slot(14)), nextDay(slot(15))));
    assert.equal(outsideAbsence.status, 201, JSON.stringify(outsideAbsence.body));
    assert.equal(outsideAbsence.body.instructor, "Mike");

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
    assert.deepEqual(sends[0].body.data, { courseId: morning.id, memberId: members[0].id });
    assert.doesNotMatch(JSON.stringify(sends[0]), /krank|Mike|Abwesenheit/i);
    const [noticeAfterFailure] = await db.select().from(memberNotificationsTable)
      .where(eq(memberNotificationsTable.courseId, morning.id));
    assert.ok(noticeAfterFailure, "In-App notification survives provider failure");
    const retried = await api(manager.clerkUserId, "POST", `${prefix(morning.id)}/push/retry`);
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.pushSent, 1);
    assert.equal(sends.length, 2);
    assert.deepEqual(sends[1].body.data, { courseId: morning.id, memberId: members[0].id });
    assert.match(sends[0].body.idempotency_key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(sends[0].body.idempotency_key, sends[1].body.idempotency_key);
    assert.equal((await api(manager.clerkUserId, "POST", `${prefix(morning.id)}/resolve`,
      { action: "replace", candidateName: "Sarah" })).status, 409);
    await processTrainerAbsencePush(replaced.body.id, proxy);
    assert.equal(sends.length, 2, "successful push is never resent");

    assert.equal((await api(manager.clerkUserId, "POST", `${prefix(evening.id)}/resolve`,
      { action: "external", externalName: "  mIkE  " })).status, 400);
    const absentExternal = await api(manager.clerkUserId, "POST", `${prefix(evening.id)}/resolve`,
      { action: "external", externalName: "  lEo " });
    assert.equal(absentExternal.status, 409);
    assert.match(absentExternal.body.error, /ebenfalls abwesend/);
    const external = await api(manager.clerkUserId, "POST", `${prefix(evening.id)}/resolve`,
      { action: "external", externalName: "Externe Vertretung" });
    assert.equal(external.status, 200, JSON.stringify(external.body));
    assert.equal(external.body.instructor, "Externe Vertretung");
    assert.equal((await api(manager.clerkUserId, "POST", `/studios/${studio.id}/rooms`,
      { name: "A" })).status, 201);
    const closure = await api(manager.clerkUserId, "POST", `/studios/${studio.id}/closures`, {
      roomName: "A", fromDate: day, toDate: day,
      reason: "Raum gesperrt", responsible: "Management",
    });
    assert.equal(closure.status, 201, JSON.stringify(closure.body));
    const cancelled = await api(manager.clerkUserId, "POST", `/courses/${midday.id}/closure-resolution`, {
      closureId: closure.body.id, action: "cancel", channel: "in_app", idempotencyKey: randomUUID(),
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const [cancelledBooking] = await db.select().from(courseBookingsTable)
      .where(eq(courseBookingsTable.courseId, midday.id));
    assert.equal(cancelledBooking.status, "cancelled");
    assert.equal((await db.select().from(coursesTable).where(eq(coursesTable.id, midday.id)))[0].status, "cancelled");
    const updatedAbsence = await api(manager.clerkUserId, "GET", "/trainer-absences");
    assert.equal(updatedAbsence.status, 200);
    assert.equal(updatedAbsence.body.find((item: any) => item.id === created.body.id)
      .courses.find((course: any) => course.courseId === midday.id).status, "cancelled");
    assert.equal((await api(manager.clerkUserId, "POST", `${prefix(midday.id)}/resolve`,
      { action: "cancel" })).status, 409);
    const notices = await db.select().from(memberNotificationsTable)
      .where(inArray(memberNotificationsTable.courseId, [morning.id, midday.id, evening.id]));
    assert.equal(notices.length, 3);
    for (const notice of notices) assert.doesNotMatch(`${notice.title} ${notice.body}`, /krank|Mike|Abwesenheit/i);
    assert.match(notices.find((notice) => notice.courseId === midday.id)!.body, /abgesagt/);
    const [resolvedAlert] = await db.select().from(pulseMessagesTable).where(eq(pulseMessagesTable.id, alert.id));
    assert.ok(resolvedAlert.retractedAt, "external cancellation retires the last open trainer case");

    const [nightCourse] = await db.insert(coursesTable).values({
      studioId: studio.id, title: "Night shift", instructor: "Night Shift",
      startsAt: minutesFromMidnight(-45), endsAt: minutesFromMidnight(45),
      room: "Night shift room", capacity: 10,
    }).returning();
    const nightAbsence = await api(manager.clerkUserId, "POST", "/trainer-absences",
      { studioId: studio.id, instructor: "Night Shift", fromDate: day, toDate: day });
    assert.equal(nightAbsence.status, 201, JSON.stringify(nightAbsence.body));
    assert.ok(nightAbsence.body.courses.some((course: any) => course.courseId === nightCourse.id),
      "an absence includes a course crossing into its first day");

    // Either a concurrent new class is included in the reported absence, or
    // course creation is rejected. It must never be scheduled without review.
    await db.insert(coursesTable).values({
      studioId: studio.id, title: "Nora's class", instructor: "Nora",
      startsAt: slot(18), endsAt: slot(19), room: "Nora's room", capacity: 10,
    });
    const [noraAbsence, concurrentCourse] = await Promise.all([
      api(manager.clerkUserId, "POST", "/trainer-absences",
        { studioId: studio.id, instructor: "Nora", fromDate: day, toDate: day }),
      api(manager.clerkUserId, "POST", "/courses",
        newCourse("  nOrA  ", slot(21), slot(22), "Other room")),
    ]);
    assert.equal(noraAbsence.status, 201, JSON.stringify(noraAbsence.body));
    assert.ok([201, 409].includes(concurrentCourse.status), JSON.stringify(concurrentCourse.body));
    if (concurrentCourse.status === 201) {
      assert.ok(noraAbsence.body.courses.some((course: any) => course.courseId === concurrentCourse.body.id),
        "course created first must be captured by the absence");
    } else {
      assert.match(concurrentCourse.body.error, /abwesend/);
    }
  } finally {
    if (server) { server.close(); await once(server, "close"); }
    if (organizationId !== undefined) {
      await db.transaction(async (tx) => {
        const studioIds = (await tx.select({ id: studiosTable.id }).from(studiosTable)
          .where(eq(studiosTable.organizationId, organizationId!))).map((item) => item.id);
        const closureIds = (await tx.select({ id: roomClosuresTable.id }).from(roomClosuresTable)
          .where(inArray(roomClosuresTable.studioId, studioIds))).map((item) => item.id);
        if (closureIds.length) {
          await tx.delete(courseClosureResolutionsTable)
            .where(inArray(courseClosureResolutionsTable.closureId, closureIds));
        }
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
    if (foreignOrganizationId !== undefined) {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, foreignOrganizationId));
    }
  }
});