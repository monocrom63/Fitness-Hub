import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import express from "express";
import {
  courseBookingsTable,
  coursesTable,
  db,
  memberNotificationsTable,
  membersTable,
  organizationsTable,
  pool,
  staffTable,
  studiosTable,
} from "@workspace/db";
import courseBookingsRouter from "../src/routes/course-bookings";

test("course rosters and staff cancellation enforce manager and studio access", async (t) => {
  const run = randomUUID();
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  const organizationIds: number[] = [];

  try {
    const [orgA] = await db.insert(organizationsTable)
      .values({ name: `Course roster A ${run}` }).returning();
    organizationIds.push(orgA.id);
    const [orgB] = await db.insert(organizationsTable)
      .values({ name: `Course roster B ${run}` }).returning();
    organizationIds.push(orgB.id);
    const [studioA1, studioA2, studioB] = await db.insert(studiosTable).values([
      { organizationId: orgA.id, name: `A1 ${run}`, city: "Berlin" },
      { organizationId: orgA.id, name: `A2 ${run}`, city: "Berlin" },
      { organizationId: orgB.id, name: `B ${run}`, city: "Hamburg" },
    ]).returning();
    const users = {
      district: `course-district-${run}`,
      managerA1: `course-manager-a1-${run}`,
      managerA2: `course-manager-a2-${run}`,
      managerB: `course-manager-b-${run}`,
      employee: `course-employee-${run}`,
    };
    await db.insert(staffTable).values([
      { clerkUserId: users.district, organizationId: orgA.id, studioId: null, fullName: "District", email: `district-${run}@example.invalid`, role: "district_manager" },
      { clerkUserId: users.managerA1, organizationId: orgA.id, studioId: studioA1.id, fullName: "Manager A1", email: `manager-a1-${run}@example.invalid`, role: "studio_manager" },
      { clerkUserId: users.managerA2, organizationId: orgA.id, studioId: studioA2.id, fullName: "Manager A2", email: `manager-a2-${run}@example.invalid`, role: "studio_manager" },
      { clerkUserId: users.managerB, organizationId: orgB.id, studioId: studioB.id, fullName: "Manager B", email: `manager-b-${run}@example.invalid`, role: "studio_manager" },
      { clerkUserId: users.employee, organizationId: orgA.id, studioId: studioA1.id, fullName: "Employee", email: `employee-${run}@example.invalid`, role: "studio_employee" },
    ]);
    const [confirmedMember, firstWaitlisted, secondWaitlisted, otherStudioMember] =
      await db.insert(membersTable).values([
        { studioId: studioA1.id, fullName: "Confirmed Member", email: `confirmed-${run}@example.invalid`, phone: "111", membershipType: "Standard" },
        { studioId: studioA1.id, fullName: "First Waitlisted", email: `first-${run}@example.invalid`, phone: "222", membershipType: "Standard" },
        { studioId: studioA1.id, fullName: "Second Waitlisted", email: `second-${run}@example.invalid`, phone: "333", membershipType: "Standard" },
        { studioId: studioA2.id, fullName: "Other Studio Member", email: `other-${run}@example.invalid`, phone: "444", membershipType: "Standard" },
      ]).returning();
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const [courseA, courseA2, courseB] = await db.insert(coursesTable).values([
      { studioId: studioA1.id, title: `A1 course ${run}`, instructor: "Instructor", startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000), capacity: 1, enrolled: 1, room: "A", status: "full" },
      { studioId: studioA2.id, title: `A2 course ${run}`, instructor: "Instructor", startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000), capacity: 1, enrolled: 0, room: "A" },
      { studioId: studioB.id, title: `B course ${run}`, instructor: "Instructor", startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000), capacity: 1, enrolled: 0, room: "A" },
    ]).returning();
    await db.insert(courseBookingsTable).values([
      { courseId: courseA.id, memberId: confirmedMember.id, status: "confirmed", createdAt: new Date(Date.now() - 3000) },
      { courseId: courseA.id, memberId: firstWaitlisted.id, status: "waitlisted", createdAt: new Date(Date.now() - 2000) },
      { courseId: courseA.id, memberId: secondWaitlisted.id, status: "waitlisted", createdAt: new Date(Date.now() - 1000) },
      { courseId: courseA2.id, memberId: otherStudioMember.id, status: "confirmed" },
    ]);

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
    app.use("/api", courseBookingsRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

    async function api<T = unknown>(user: string | null, method: "GET" | "DELETE" | "POST", path: string, data?: unknown) {
      const payload = data ?? (method === "DELETE" ? { expectedStatus: "confirmed" } : undefined);
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          ...(user ? { "x-test-user": user } : {}),
          ...(payload ? { "content-type": "application/json" } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      return { status: response.status, body: await response.json() as T };
    }

    await t.test("only managers with access to the course studio can read rosters", async () => {
      assert.equal((await api(null, "GET", `/courses/${courseA.id}/bookings`)).status, 401);
      assert.equal((await api("unknown-user", "GET", `/courses/${courseA.id}/bookings`)).status, 403);
      assert.equal((await api(users.employee, "GET", `/courses/${courseA.id}/bookings`)).status, 403);
      assert.equal((await api(users.managerA2, "GET", `/courses/${courseA.id}/bookings`)).status, 404);
      assert.equal((await api(users.managerB, "GET", `/courses/${courseA.id}/bookings`)).status, 404);
      assert.equal((await api(users.district, "GET", `/courses/${courseB.id}/bookings`)).status, 404);

      const { status, body } = await api<Array<{
        id: number;
        memberId: number;
        memberName: string;
        status: string;
        waitlistPosition: number | null;
      }>>(users.managerA1, "GET", `/courses/${courseA.id}/bookings`);
      assert.equal(status, 200);
      assert.deepEqual(body.map(({ memberId, status, waitlistPosition }) => ({
        memberId, status, waitlistPosition,
      })), [
        { memberId: confirmedMember.id, status: "confirmed", waitlistPosition: null },
        { memberId: firstWaitlisted.id, status: "waitlisted", waitlistPosition: 1 },
        { memberId: secondWaitlisted.id, status: "waitlisted", waitlistPosition: 2 },
      ]);
      assert.equal(JSON.stringify(body).includes("@example.invalid"), false);
      assert.equal(JSON.stringify(body).includes("phone"), false);
      const districtRoster = await api<Array<{ memberId: number }>>(
        users.district, "GET", `/courses/${courseA.id}/bookings`,
      );
      assert.equal(districtRoster.status, 200);
      assert.equal(districtRoster.body.length, 3);
    });

    await t.test("staff cancellation is restricted and promotes the FIFO waitlist", async () => {
      assert.equal((await api(null, "DELETE", `/courses/${courseA.id}/bookings/${confirmedMember.id}`)).status, 401);
      assert.equal((await api(users.employee, "DELETE", `/courses/${courseA.id}/bookings/${confirmedMember.id}`)).status, 403);
      assert.equal((await api(users.employee, "POST", `/courses/${courseA.id}/bookings`, { memberId: confirmedMember.id })).status, 403);
      assert.equal((await api(users.managerA2, "DELETE", `/courses/${courseA.id}/bookings/${confirmedMember.id}`)).status, 404);
      assert.equal((await api(users.managerB, "DELETE", `/courses/${courseA.id}/bookings/${confirmedMember.id}`)).status, 404);
      assert.equal((await api(users.managerA1, "DELETE", `/courses/${courseA.id}/bookings/${otherStudioMember.id}`)).status, 404);
      assert.equal((await api(users.managerA1, "DELETE", `/courses/${courseA.id}/bookings/999999999`)).status, 404);
      assert.equal((await api(users.managerA1, "DELETE", `/courses/${courseA.id}/bookings/${confirmedMember.id}`, {
        expectedStatus: "waitlisted",
      })).status, 409);

      const cancellation = await api<{ id: number; courseId: number; memberId: number; status: string }>(
        users.managerA1, "DELETE", `/courses/${courseA.id}/bookings/${confirmedMember.id}`,
      );
      assert.equal(cancellation.status, 200);
      assert.deepEqual(cancellation.body, {
        id: (await db.select({ id: courseBookingsTable.id }).from(courseBookingsTable)
          .where(eq(courseBookingsTable.memberId, confirmedMember.id)))[0]?.id,
        courseId: courseA.id,
        memberId: confirmedMember.id,
        status: "cancelled",
        waitlistPosition: null,
      });
      const [promoted] = await db.select({ status: courseBookingsTable.status })
        .from(courseBookingsTable).where(eq(courseBookingsTable.memberId, firstWaitlisted.id));
      assert.equal(promoted.status, "confirmed");
      const cancelledMemberNotice = await db.select().from(memberNotificationsTable)
        .where(eq(memberNotificationsTable.memberId, confirmedMember.id));
      assert.equal(cancelledMemberNotice.length, 1);
      assert.match(cancelledMemberNotice[0].title, /storniert/);
      const promotedMemberNotice = await db.select().from(memberNotificationsTable)
        .where(eq(memberNotificationsTable.memberId, firstWaitlisted.id));
      assert.equal(promotedMemberNotice.length, 1);
      assert.match(promotedMemberNotice[0].title, /bestätigt/);
    });
  } finally {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => error ? reject(error) : resolve()),
      );
    }
    for (const id of organizationIds) {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, id));
    }
    await pool.end();
  }
});