import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import express from "express";
import {
  checkInsTable,
  db,
  membersTable,
  organizationsTable,
  pool,
  staffTable,
  studiosTable,
} from "@workspace/db";
import portalRouter from "../src/routes/portal";

type MemberView = { id: number; email: string; phone: string | null; studioId: number };

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
    const [districtA, managerA1, managerA2, employeeA1, districtB] =
      await db.insert(staffTable).values([
        { clerkUserId: `member-district-a-${run}`, organizationId: orgA.id, studioId: null, fullName: "District A", email: `district-a-${run}@example.com`, role: "district_manager" },
        { clerkUserId: `member-manager-a1-${run}`, organizationId: orgA.id, studioId: studioA1.id, fullName: "Manager A1", email: `manager-a1-${run}@example.com`, role: "studio_manager" },
        { clerkUserId: `member-manager-a2-${run}`, organizationId: orgA.id, studioId: studioA2.id, fullName: "Manager A2", email: `manager-a2-${run}@example.com`, role: "studio_manager" },
        { clerkUserId: `member-employee-a1-${run}`, organizationId: orgA.id, studioId: studioA1.id, fullName: "Employee A1", email: `employee-a1-${run}@example.com`, role: "studio_employee" },
        { clerkUserId: `member-district-b-${run}`, organizationId: orgB.id, studioId: null, fullName: "District B", email: `district-b-${run}@example.com`, role: "district_manager" },
      ]).returning();
    const [memberA1, memberA2, memberB] = await db.insert(membersTable).values([
      { studioId: studioA1.id, fullName: "Member A1", email: `private-a1-${run}@example.com`, phone: "111", membershipType: "Standard" },
      { studioId: studioA2.id, fullName: "Member A2", email: `private-a2-${run}@example.com`, phone: "222", membershipType: "Standard" },
      { studioId: studioB.id, fullName: "Member B", email: `private-b-${run}@example.com`, phone: "333", membershipType: "Standard" },
    ]).returning();

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
      assert.deepEqual(ids(await list(managerA1.clerkUserId)), [memberA1.id]);
      assert.deepEqual(ids(await list(employeeA1.clerkUserId)), [memberA1.id]);
      assert.deepEqual(ids(await list(managerA2.clerkUserId)), [memberA2.id]);
      assert.deepEqual(ids(await list(districtA.clerkUserId)), [memberA1.id, memberA2.id].sort((a, b) => a - b));
      assert.deepEqual(ids(await list(districtB.clerkUserId)), [memberB.id]);
      assert.deepEqual(await list(managerA1.clerkUserId, `?search=${encodeURIComponent(memberA2.email)}`), []);
      assert.deepEqual(await list(districtA.clerkUserId, `?search=${encodeURIComponent(memberB.email)}`), []);
      assert.deepEqual(ids(await list(districtA.clerkUserId, `?studioId=${studioA2.id}`)), [memberA2.id]);
      assert.equal((await api(managerA1.clerkUserId, "GET", `/members?studioId=${studioA2.id}`)).status, 403);
      assert.equal((await api(managerA1.clerkUserId, "GET", `/members?studioId=${studioB.id}`)).status, 403);
      assert.equal((await api(districtA.clerkUserId, "GET", `/members?studioId=${studioB.id}`)).status, 403);
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
        assert.equal(response.status, 403);
        assert.equal(JSON.stringify(response.body).includes("private-"), false);
      }
      const protectedRows = await db.select({ id: membersTable.id, phone: membersTable.phone })
        .from(membersTable).where(inArray(membersTable.id, [memberA2.id, memberB.id]));
      assert.deepEqual(protectedRows.map((row) => row.phone).sort(), ["222", "333"]);
      assert.equal((await api(managerA1.clerkUserId, "PATCH", "/members/999999999", { phone: "999" })).status, 404);

      const own = await api<MemberView>(managerA1.clerkUserId, "PATCH", `/members/${memberA1.id}`, { phone: "444" });
      assert.equal(own.status, 200);
      assert.equal(own.body.phone, "444");
      const district = await api<MemberView>(districtA.clerkUserId, "PATCH", `/members/${memberA2.id}`, { phone: "555" });
      assert.equal(district.status, 200);
      assert.equal(district.body.phone, "555");
    });

    await t.test("member creation and check-ins cannot target an inaccessible studio", async () => {
      assert.equal((await api(managerA1.clerkUserId, "POST", "/members", draft(studioA2.id))).status, 403);
      assert.equal((await api(managerA1.clerkUserId, "POST", "/members", draft(studioB.id))).status, 403);
      assert.equal((await api(districtA.clerkUserId, "POST", "/members", draft(studioB.id))).status, 403);
      const own = await api<MemberView>(employeeA1.clerkUserId, "POST", "/members", draft(studioA1.id));
      assert.equal(own.status, 201);
      assert.equal(own.body.studioId, studioA1.id);

      assert.equal((await api(employeeA1.clerkUserId, "POST", "/check-ins", { memberId: memberA2.id, studioId: studioA2.id })).status, 403);
      assert.equal((await api(employeeA1.clerkUserId, "POST", "/check-ins", { memberId: memberA2.id, studioId: studioA1.id })).status, 404);
      assert.equal((await api(districtA.clerkUserId, "POST", "/check-ins", { memberId: memberB.id, studioId: studioB.id })).status, 403);
      assert.equal((await api(districtB.clerkUserId, "POST", "/check-ins", { memberId: memberA1.id, studioId: studioB.id })).status, 404);
      const foreignCheckIns = await db.select({ memberId: checkInsTable.memberId })
        .from(checkInsTable).where(inArray(checkInsTable.memberId, [memberA2.id, memberB.id]));
      assert.deepEqual(foreignCheckIns, []);
      assert.equal((await api(employeeA1.clerkUserId, "POST", "/check-ins", { memberId: memberA1.id, studioId: studioA1.id })).status, 201);
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