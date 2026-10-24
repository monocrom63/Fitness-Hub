import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import express from "express";
import {
  checkInsTable,
  coursesTable,
  db,
  membersTable,
  organizationModulesTable,
  organizationsTable,
  pool,
  pulseMessagesTable,
  staffTable,
  studiosTable,
} from "@workspace/db";
import portalRouter from "../src/routes/portal";

type MemberView = { id: number; fullName: string; email: string | null; phone: string | null; studioId: number };

test("member records remain inside the caller's studio and organization", async (t) => {
  const run = randomUUID();
  const organizationIds: number[] = [];
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;

  try {
    const [orgA] = await db.insert(organizationsTable)
      .values({ name: `Member access test A ${run}` }).returning();
    organizationIds.push(orgA.id);
    const [orgB] = await db.insert(organizationsTable)
      .values({ name: `Member access test B ${run}` }).returning();
    organizationIds.push(orgB.id);

    const [studioA1, studioA2, studioB] = await db.insert(studiosTable).values([
      { organizationId: orgA.id, name: `A1 ${run}`, city: "Berlin" },
      { organizationId: orgA.id, name: `A2 ${run}`, city: "Berlin" },
      { organizationId: orgB.id, name: `B ${run}`, city: "Hamburg" },
    ]).returning();

    const [districtA, managerA1, managerA2, employeeA1, employeeA2, districtB, managerB, employeeB] =
      await db.insert(staffTable).values([
        { clerkUserId: `member-district-a-${run}`, organizationId: orgA.id, studioId: null, fullName: "District A", email: `district-a-${run}@example.com`, role: "district_manager" },
        { clerkUserId: `member-manager-a1-${run}`, organizationId: orgA.id, studioId: studioA1.id, fullName: "Manager A1", email: `manager-a1-${run}@example.com`, role: "studio_manager" },
        { clerkUserId: `member-manager-a2-${run}`, organizationId: orgA.id, studioId: studioA2.id, fullName: "Manager A2", email: `manager-a2-${run}@example.com`, role: "studio_manager" },
        { clerkUserId: `member-employee-a1-${run}`, organizationId: orgA.id, studioId: studioA1.id, fullName: "Employee A1", email: `employee-a1-${run}@example.com`, role: "studio_employee" },
        { clerkUserId: `member-employee-a2-${run}`, organizationId: orgA.id, studioId: studioA2.id, fullName: "Employee A2", email: `employee-a2-${run}@example.com`, role: "studio_employee" },
        { clerkUserId: `member-district-b-${run}`, organizationId: orgB.id, studioId: null, fullName: "District B", email: `district-b-${run}@example.com`, role: "district_manager" },
        { clerkUserId: `member-manager-b-${run}`, organizationId: orgB.id, studioId: studioB.id, fullName: "Manager B", email: `manager-b-${run}@example.com`, role: "studio_manager" },
        { clerkUserId: `member-employee-b-${run}`, organizationId: orgB.id, studioId: studioB.id, fullName: "Employee B", email: `employee-b-${run}@example.com`, role: "studio_employee" },
      ]).returning();
    // A stale or incorrectly imported assignment must not grant access to another organization's studio.
    const [mismatchedManager] = await db.insert(staffTable).values({
      clerkUserId: `member-mismatched-${run}`, organizationId: orgA.id, studioId: studioB.id,
      fullName: "Mismatched Manager", email: `mismatched-${run}@example.com`, role: "studio_manager",
    }).returning();
    const [memberA1, memberA2, memberB] = await db.insert(membersTable).values([
      { studioId: studioA1.id, fullName: "Member A1", email: `private-a1-${run}@example.com`, phone: "111", membershipType: "Standard" },
      { studioId: studioA2.id, fullName: "Member A2", email: `private-a2-${run}@example.com`, phone: "222", membershipType: "Standard" },
      { studioId: studioB.id, fullName: "Member B", email: `private-b-${run}@example.com`, phone: "333", membershipType: "Standard" },
    ]).returning();
    const [fullCourse] = await db.insert(coursesTable).values({
      studioId: studioA1.id,
      title: `Full course ${run}`,
      instructor: "Instructor",
      startsAt: new Date(Date.now() + 60 * 60 * 1000),
      endsAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      capacity: 10,
      enrolled: 10,
      room: "Main room",
      status: "full",
    }).returning();

    const app = express();
    app.use(express.json());
    // Only this local test server supplies a Clerk-shaped identity; the live router is unchanged.
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user") ?? null;
      const auth = Object.assign(() => ({ userId, tokenType: "session_token" }), {
        [Symbol.for("@clerk/express.auth")]: true,
      });
      Object.assign(req, { auth });
      next();
    });
    app.use("/api", portalRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

    async function api<T = unknown>(
      user: string | null,
      method: "GET" | "POST" | "PATCH",
      path: string,
      data?: unknown,
    ): Promise<{ status: number; body: T }> {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          ...(user ? { "x-test-user": user } : {}),
          ...(data === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      return { status: response.status, body: await response.json() as T };
    }
    async function list(user: string, query = "") {
      const response = await api<MemberView[]>(user, "GET", `/members${query}`);
      assert.equal(response.status, 200);
      return response.body;
    }
    const ids = (rows: MemberView[]) => rows.map((row) => row.id).sort((a, b) => a - b);
    const draft = (studioId: number) => ({
      studioId, fullName: "New Member", email: `new-${run}@example.com`, membershipType: "Standard",
    });

    await t.test("anonymous and unassigned accounts cannot read member records", async () => {
      assert.equal((await api(null, "GET", "/members")).status, 401);
      assert.equal((await api("unknown-test-user", "GET", "/members")).status, 403);
      assert.equal((await api(null, "PATCH", `/members/${memberA1.id}`, { phone: "999" })).status, 401);
    });

    await t.test("lists and searches expose only accessible studios", async () => {
      for (const [staff, visibleIds] of [
        [employeeA1, [memberA1.id]],
        [managerA1, [memberA1.id]],
        [employeeA2, [memberA2.id]],
        [managerA2, [memberA2.id]],
        [districtA, [memberA1.id, memberA2.id]],
        [employeeB, [memberB.id]],
        [managerB, [memberB.id]],
        [districtB, [memberB.id]],
      ] as const) {
        assert.deepEqual(ids(await list(staff.clerkUserId)), [...visibleIds].sort((a, b) => a - b), staff.role);
      }
      assert.deepEqual(await list(managerA1.clerkUserId, `?search=${encodeURIComponent(memberA2.email)}`), []);
      assert.deepEqual(await list(districtA.clerkUserId, `?search=${encodeURIComponent(memberB.email)}`), []);
      assert.deepEqual(await list(managerB.clerkUserId, `?search=${encodeURIComponent(memberA1.email)}`), []);
      const employeeRows = await list(employeeA1.clerkUserId);
      assert.equal(employeeRows[0]?.email, null);
      assert.equal(employeeRows[0]?.phone, null);
      assert.deepEqual(
        ids(await list(employeeA1.clerkUserId, `?search=${encodeURIComponent(memberA1.fullName)}`)),
        [memberA1.id],
      );
      assert.deepEqual(
        await list(employeeA1.clerkUserId, `?search=${encodeURIComponent(memberA1.email)}`),
        [],
      );
      assert.deepEqual(ids(await list(districtA.clerkUserId, `?studioId=${studioA2.id}`)), [memberA2.id]);
      assert.equal((await api(managerA1.clerkUserId, "GET", `/members?studioId=${studioA2.id}`)).status, 403);
      assert.equal((await api(managerA1.clerkUserId, "GET", `/members?studioId=${studioB.id}`)).status, 403);
      assert.equal((await api(districtA.clerkUserId, "GET", `/members?studioId=${studioB.id}`)).status, 403);
    });

    await t.test("a staff assignment pointing to a different organization cannot open private records", async () => {
      assert.deepEqual(await list(mismatchedManager.clerkUserId), []);
      assert.deepEqual(await list(mismatchedManager.clerkUserId, `?search=${encodeURIComponent(memberB.email)}`), []);
      const filtered = await api(mismatchedManager.clerkUserId, "GET", `/members?studioId=${studioB.id}`);
      assert.equal(filtered.status, 403);
      assert.equal(JSON.stringify(filtered.body).includes(memberB.email), false);
      const edit = await api(mismatchedManager.clerkUserId, "PATCH", `/members/${memberB.id}`, { phone: "999" });
      assert.equal(edit.status, 403);
      assert.equal(JSON.stringify(edit.body).includes(memberB.email), false);
      const [unchanged] = await db.select({ phone: membersTable.phone })
        .from(membersTable).where(eq(membersTable.id, memberB.id));
      assert.equal(unchanged.phone, "333");
    });

    await t.test("a stale cross-organization staff assignment cannot create a member", async () => {
      const email = `stale-assignment-${run}@example.com`;
      const input = { ...draft(studioB.id), email };
      const before = await db.select({ id: membersTable.id })
        .from(membersTable).where(inArray(membersTable.studioId, [studioA1.id, studioA2.id, studioB.id]))
        .orderBy(membersTable.id);
      const foreignStudio = await api(mismatchedManager.clerkUserId, "POST", "/members", input);
      assert.equal(foreignStudio.status, 403);
      assert.equal(JSON.stringify(foreignStudio.body).includes(email), false);
      // Merely switching the submitted studio to the manager's original organization
      // must not grant access either: the assignment still points to the foreign studio.
      const ownOrganization = await api(mismatchedManager.clerkUserId, "POST", "/members", {
        ...input, studioId: studioA1.id,
      });
      assert.equal(ownOrganization.status, 403);
      const rows = await db.select({ id: membersTable.id, studioId: membersTable.studioId })
        .from(membersTable).where(eq(membersTable.email, email));
      assert.deepEqual(rows, []);
      assert.deepEqual(
        await db.select({ id: membersTable.id })
          .from(membersTable).where(inArray(membersTable.studioId, [studioA1.id, studioA2.id, studioB.id]))
          .orderBy(membersTable.id),
        before,
        "denied creates must leave all fixture studios' member records unchanged",
      );

      const legitimate = await api<MemberView>(managerB.clerkUserId, "POST", "/members", input);
      assert.equal(legitimate.status, 201);
      assert.equal(legitimate.body.studioId, studioB.id);
      assert.deepEqual(
        await db.select({ studioId: membersTable.studioId }).from(membersTable).where(eq(membersTable.email, email)),
        [{ studioId: studioB.id }],
      );
    });

    await t.test("a stale cross-organization staff assignment cannot create a check-in", async () => {
      for (const member of [memberB, memberA1, memberA2]) {
        const response = await api(mismatchedManager.clerkUserId, "POST", "/check-ins", {
          memberId: member.id,
          studioId: member.studioId,
        });
        assert.equal(response.status, 403, `must not check in member ${member.id}`);
        assert.equal(JSON.stringify(response.body).includes(member.email), false);
      }
      const checkIns = await db.select({ id: checkInsTable.id })
        .from(checkInsTable).where(inArray(checkInsTable.studioId, [studioA1.id, studioA2.id, studioB.id]));
      assert.deepEqual(checkIns, [], "denied check-ins must not persist in any fixture studio");
    });

    await t.test("a foreign member ID cannot be edited or returned", async () => {
      for (const [user, id] of [
        [employeeA1.clerkUserId, memberA2.id],
        [managerA1.clerkUserId, memberA2.id],
        [managerA1.clerkUserId, memberB.id],
        [districtA.clerkUserId, memberB.id],
        [districtB.clerkUserId, memberA1.id],
      ] as const) {
        const response = await api(user, "PATCH", `/members/${id}`, { phone: "999" });
        assert.equal(response.status, 403, `${user} must not edit member ${id}`);
        assert.equal(JSON.stringify(response.body).includes("private-"), false);
      }
      const protectedRows = await db.select({ id: membersTable.id, phone: membersTable.phone })
        .from(membersTable).where(inArray(membersTable.id, [memberA1.id, memberA2.id, memberB.id]));
      assert.deepEqual(
        new Map(protectedRows.map((row) => [row.id, row.phone])),
        new Map([[memberA1.id, "111"], [memberA2.id, "222"], [memberB.id, "333"]]),
      );
      assert.equal((await api(managerA1.clerkUserId, "PATCH", "/members/999999999", { phone: "999" })).status, 404);

      const own = await api<MemberView>(managerA1.clerkUserId, "PATCH", `/members/${memberA1.id}`, { phone: "444" });
      assert.equal(own.status, 200);
      assert.equal(own.body.phone, "444");
      const district = await api<MemberView>(districtA.clerkUserId, "PATCH", `/members/${memberA2.id}`, { phone: "555" });
      assert.equal(district.status, 200);
      assert.equal(district.body.phone, "555");

      const employeePatch = await api<MemberView>(
        employeeA1.clerkUserId,
        "PATCH",
        `/members/${memberA1.id}`,
        { phone: "666" },
      );
      assert.equal(employeePatch.status, 200);
      assert.equal(employeePatch.body.phone, "666");
      const employeeStatus = await api<MemberView>(
        employeeA1.clerkUserId, "PATCH", `/members/${memberA1.id}`, { status: "paused" },
      );
      assert.equal(employeeStatus.status, 200);
      const [pausedMember] = await db.select({ status: membersTable.status })
        .from(membersTable).where(eq(membersTable.id, memberA1.id));
      assert.equal(pausedMember.status, "paused");
      const restoredStatus = await api<MemberView>(
        managerA1.clerkUserId, "PATCH", `/members/${memberA1.id}`, { status: "active" },
      );
      assert.equal(restoredStatus.status, 200);
      const unchanged = await db.select({ phone: membersTable.phone })
        .from(membersTable).where(eq(membersTable.id, memberA1.id));
      assert.equal(unchanged[0]?.phone, "666");
    });

    await t.test("member creation and check-ins cannot target an inaccessible studio", async () => {
      assert.equal((await api(managerA1.clerkUserId, "POST", "/members", draft(studioA2.id))).status, 403);
      assert.equal((await api(managerA1.clerkUserId, "POST", "/members", draft(studioB.id))).status, 403);
      assert.equal((await api(districtA.clerkUserId, "POST", "/members", draft(studioB.id))).status, 403);
      const employeeCreate = await api(employeeA1.clerkUserId, "POST", "/members", draft(studioA1.id));
      assert.equal(employeeCreate.status, 403);
      const createdByEmployee = await db.select({ id: membersTable.id })
        .from(membersTable).where(eq(membersTable.email, `new-${run}@example.com`));
      assert.deepEqual(createdByEmployee, []);

      assert.equal((await api(employeeA1.clerkUserId, "POST", "/check-ins", { memberId: memberA2.id, studioId: studioA2.id })).status, 403);
      assert.equal((await api(employeeA1.clerkUserId, "POST", "/check-ins", { memberId: memberA2.id, studioId: studioA1.id })).status, 404);
      assert.equal((await api(districtA.clerkUserId, "POST", "/check-ins", { memberId: memberB.id, studioId: studioB.id })).status, 403);
      assert.equal((await api(districtB.clerkUserId, "POST", "/check-ins", { memberId: memberA1.id, studioId: studioB.id })).status, 404);
      const foreignCheckIns = await db.select({ memberId: checkInsTable.memberId })
        .from(checkInsTable).where(inArray(checkInsTable.memberId, [memberA2.id, memberB.id]));
      assert.deepEqual(foreignCheckIns, []);
      assert.equal((await api(employeeA1.clerkUserId, "POST", "/check-ins", { memberId: memberA1.id, studioId: studioA1.id })).status, 201);
    });

    await t.test("dashboard respects member/course modules and hides member names from employees", async () => {
      const employeeDashboard = await api<{
        metrics: Array<{ label: string }>;
        activities: Array<{ description: string }>;
        courses: Array<{ id: number; status: string }>;
      }>(employeeA1.clerkUserId, "GET", "/dashboard");
      assert.equal(employeeDashboard.status, 200);
      assert.equal(
        employeeDashboard.body.activities.some((item) => item.description.includes("Member A1")),
        false,
      );
      assert.equal(employeeDashboard.body.courses.some((course) => course.id === fullCourse.id), true);

      await db.insert(organizationModulesTable).values([
        { organizationId: orgA.id, key: "members", enabled: 0 },
        { organizationId: orgA.id, key: "courses", enabled: 0 },
      ]).onConflictDoUpdate({
        target: [organizationModulesTable.organizationId, organizationModulesTable.key],
        set: { enabled: 0 },
      });
      const disabledDashboard = await api<{
        metrics: Array<{ label: string }>;
        activities: Array<{ description: string }>;
        courses: Array<{ id: number }>;
      }>(employeeA1.clerkUserId, "GET", "/dashboard");
      assert.equal(disabledDashboard.status, 200);
      assert.deepEqual(disabledDashboard.body.metrics, []);
      assert.deepEqual(disabledDashboard.body.activities, []);
      assert.deepEqual(disabledDashboard.body.courses, []);
    });

    await t.test("course creation commits a generic Pulse event with the course", async () => {
      const startsAt = new Date(Date.now() + 5 * 60 * 60 * 1000);
      const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
      const courseBody = {
        title: `Pulse event course ${run}`,
        instructor: "Instructor",
        studioId: studioA1.id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        capacity: 12,
        room: "Studio room",
      };
      const created = await api(managerA1.clerkUserId, "POST", "/courses", courseBody);
      assert.equal(created.status, 201);
      const events = await db.select({
        title: pulseMessagesTable.title,
        body: pulseMessagesTable.body,
        authorStaffId: pulseMessagesTable.authorStaffId,
        studioId: pulseMessagesTable.studioId,
      }).from(pulseMessagesTable).where(
        and(
          eq(pulseMessagesTable.organizationId, orgA.id),
          eq(pulseMessagesTable.title, "Neuer Kurs geplant"),
          eq(pulseMessagesTable.authorStaffId, managerA1.id),
        ),
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]?.studioId, studioA1.id);
      assert.equal(events[0]?.body.includes(memberA1.fullName), false);
      assert.equal(events[0]?.body.includes(memberA1.email), false);
      const failedCourse = await api(managerA1.clerkUserId, "POST", "/courses", {
        ...courseBody,
        endsAt: startsAt.toISOString(),
      });
      assert.equal(failedCourse.status, 400);
      const afterFailure = await db.select({ id: pulseMessagesTable.id })
        .from(pulseMessagesTable).where(
          and(
            eq(pulseMessagesTable.organizationId, orgA.id),
            eq(pulseMessagesTable.title, "Neuer Kurs geplant"),
            eq(pulseMessagesTable.authorStaffId, managerA1.id),
          ),
        );
      assert.equal(afterFailure.length, 1);
    });

    await t.test("concurrent check-ins emit a milestone exactly once", async () => {
      const existing = await db.select({ id: checkInsTable.id })
        .from(checkInsTable).where(
          and(
            eq(checkInsTable.checkedInByStaffId, employeeA1.id),
            eq(checkInsTable.studioId, studioA1.id),
          ),
        );
      assert.ok(existing.length < 10);
      const toSeed = 9 - existing.length;
      if (toSeed > 0) {
        await db.insert(checkInsTable).values(
          Array.from({ length: toSeed }, () => ({
            memberId: memberA1.id,
            studioId: studioA1.id,
            checkedInByStaffId: employeeA1.id,
          })),
        );
      }

      const responses = await Promise.all([
        api(employeeA1.clerkUserId, "POST", "/check-ins", {
          memberId: memberA1.id,
          studioId: studioA1.id,
        }),
        api(employeeA1.clerkUserId, "POST", "/check-ins", {
          memberId: memberA1.id,
          studioId: studioA1.id,
        }),
      ]);
      assert.deepEqual(responses.map((response) => response.status), [201, 201]);
      const milestoneEvents = await db.select({
        title: pulseMessagesTable.title,
        body: pulseMessagesTable.body,
        studioId: pulseMessagesTable.studioId,
      }).from(pulseMessagesTable).where(
        and(
          eq(pulseMessagesTable.organizationId, orgA.id),
          eq(pulseMessagesTable.authorStaffId, employeeA1.id),
          eq(pulseMessagesTable.title, "Check-in-Meilenstein erreicht"),
        ),
      );
      assert.equal(milestoneEvents.length, 1);
      assert.equal(milestoneEvents[0]?.studioId, studioA1.id);
      assert.equal(milestoneEvents[0]?.body.includes(memberA1.fullName), false);
      assert.equal(milestoneEvents[0]?.body.includes(memberA1.email), false);
      const finalCount = await db.select({ id: checkInsTable.id })
        .from(checkInsTable).where(
          and(
            eq(checkInsTable.checkedInByStaffId, employeeA1.id),
            eq(checkInsTable.studioId, studioA1.id),
          ),
        );
      assert.equal(finalCount.length, 11);
    });

    await t.test("course and check-in writes succeed without Pulse events when disabled", async () => {
      await db.insert(organizationModulesTable).values({
        organizationId: orgA.id,
        key: "pulse",
        enabled: 0,
      }).onConflictDoUpdate({
        target: [organizationModulesTable.organizationId, organizationModulesTable.key],
        set: { enabled: 0 },
      });
      const previousEvents = await db.select({ id: pulseMessagesTable.id })
        .from(pulseMessagesTable).where(eq(pulseMessagesTable.organizationId, orgA.id));
      const currentCheckIns = await db.select({ id: checkInsTable.id })
        .from(checkInsTable).where(
          and(
            eq(checkInsTable.checkedInByStaffId, employeeA1.id),
            eq(checkInsTable.studioId, studioA1.id),
          ),
        );
      assert.ok(currentCheckIns.length < 25);
      const toSeed = 24 - currentCheckIns.length;
      if (toSeed > 0) {
        await db.insert(checkInsTable).values(
          Array.from({ length: toSeed }, () => ({
            memberId: memberA1.id,
            studioId: studioA1.id,
            checkedInByStaffId: employeeA1.id,
          })),
        );
      }
      const checkInResponse = await api(employeeA1.clerkUserId, "POST", "/check-ins", {
        memberId: memberA1.id,
        studioId: studioA1.id,
      });
      assert.equal(checkInResponse.status, 201);

      // Keep this class separate from the earlier Pulse-enabled class in the
      // same studio and room; this case tests module behavior, not a collision.
      const startsAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
      const courseResponse = await api(managerA1.clerkUserId, "POST", "/courses", {
        title: `Pulse disabled course ${run}`,
        instructor: "Instructor",
        studioId: studioA1.id,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000).toISOString(),
        capacity: 8,
        room: "Studio room",
      });
      assert.equal(courseResponse.status, 201);
      const afterEvents = await db.select({ id: pulseMessagesTable.id })
        .from(pulseMessagesTable).where(eq(pulseMessagesTable.organizationId, orgA.id));
      assert.equal(afterEvents.length, previousEvents.length);
    });

    await t.test("moving staff to another studio revokes old member access on the next request", async () => {
      assert.deepEqual(ids(await list(managerA1.clerkUserId)), [memberA1.id]);
      assert.deepEqual(ids(await list(employeeA1.clerkUserId)), [memberA1.id]);
      await db.update(staffTable).set({ studioId: studioA2.id })
        .where(inArray(staffTable.id, [managerA1.id, employeeA1.id]));

      for (const staff of [managerA1, employeeA1]) {
        assert.deepEqual(ids(await list(staff.clerkUserId)), [memberA2.id]);
        assert.deepEqual(await list(staff.clerkUserId, `?search=${encodeURIComponent(memberA1.fullName)}`), []);
        const foreign = await api(staff.clerkUserId, "GET", `/members?studioId=${studioA1.id}`);
        assert.equal(foreign.status, 403);
        assert.equal(JSON.stringify(foreign.body).includes(memberA1.email), false);
      }
      const oldEdit = await api(managerA1.clerkUserId, "PATCH", `/members/${memberA1.id}`, { phone: "999" });
      assert.equal(oldEdit.status, 403);
      assert.equal(JSON.stringify(oldEdit.body).includes(memberA1.email), false);
      const oldEmployeeEdit = await api(employeeA1.clerkUserId, "PATCH", `/members/${memberA1.id}`, { phone: "999" });
      assert.equal(oldEmployeeEdit.status, 403);
      assert.equal((await api(managerA1.clerkUserId, "POST", "/members", draft(studioA1.id))).status, 403);
      const newEdit = await api<MemberView>(managerA1.clerkUserId, "PATCH", `/members/${memberA2.id}`, { phone: "777" });
      assert.equal(newEdit.status, 200);
      assert.equal(newEdit.body.phone, "777");
      const [oldMember] = await db.select({ phone: membersTable.phone })
        .from(membersTable).where(eq(membersTable.id, memberA1.id));
      assert.equal(oldMember.phone, "666");
    });
  } finally {
    try {
      if (server?.listening) {
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => error ? reject(error) : resolve()),
        );
      }
    } finally {
      for (const id of organizationIds) {
        await db.delete(organizationsTable).where(eq(organizationsTable.id, id));
      }
      await pool.end();
    }
  }
});
