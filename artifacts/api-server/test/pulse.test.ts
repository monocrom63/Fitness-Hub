import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  organizationsTable,
  pulseMessagesTable,
  pulseReadsTable,
  staffTable,
  studiosTable,
  pool,
} from "@workspace/db";
import pulseRouter from "../src/routes/pulse";

type ApiResult = { status: number; body: any };

test("Pulse HTTP permissions, visibility and receipts", async (t) => {
  const run = randomUUID();
  const organizations: number[] = [];
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;

  try {
    const [orgA] = await db.insert(organizationsTable).values({ name: `Pulse test A ${run}` }).returning();
    organizations.push(orgA.id);
    const [orgB] = await db.insert(organizationsTable).values({ name: `Pulse test B ${run}` }).returning();
    organizations.push(orgB.id);
    const [studioA, studioB, studioOther] = await db.insert(studiosTable).values([
      { organizationId: orgA.id, name: `Studio A ${run}`, city: "Berlin" },
      { organizationId: orgA.id, name: `Studio B ${run}`, city: "Berlin" },
      { organizationId: orgB.id, name: `Other studio ${run}`, city: "Berlin" },
    ]).returning();
    const [district, managerA, managerB, employeeA, employeeB, otherDistrict] =
      await db.insert(staffTable).values([
        { clerkUserId: `pulse-district-${run}`, organizationId: orgA.id, studioId: null, fullName: "District A", email: `district-${run}@test.invalid`, role: "district_manager" },
        { clerkUserId: `pulse-manager-a-${run}`, organizationId: orgA.id, studioId: studioA.id, fullName: "Manager A", email: `manager-a-${run}@test.invalid`, role: "studio_manager" },
        { clerkUserId: `pulse-manager-b-${run}`, organizationId: orgA.id, studioId: studioB.id, fullName: "Manager B", email: `manager-b-${run}@test.invalid`, role: "studio_manager" },
        { clerkUserId: `pulse-employee-a-${run}`, organizationId: orgA.id, studioId: studioA.id, fullName: "Employee A", email: `employee-a-${run}@test.invalid`, role: "studio_employee" },
        { clerkUserId: `pulse-employee-b-${run}`, organizationId: orgA.id, studioId: studioB.id, fullName: "Employee B", email: `employee-b-${run}@test.invalid`, role: "studio_employee" },
        { clerkUserId: `pulse-other-${run}`, organizationId: orgB.id, studioId: studioOther.id, fullName: "District B", email: `other-${run}@test.invalid`, role: "district_manager" },
      ]).returning();

    // This is a test-only server: production Clerk middleware is not replaced or modified.
    // Mimic only the verified auth object Clerk normally attaches to a request.
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
    app.use("/api", pulseRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;

    async function api(user: string | null, method: "GET" | "POST", path: string, data?: unknown): Promise<ApiResult> {
      const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
        method,
        headers: {
          ...(user ? { "x-test-user": user } : {}),
          ...(data ? { "content-type": "application/json" } : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      return { status: response.status, body: await response.json() };
    }
    const user = (staff: typeof district) => staff.clerkUserId;
    const draft = (studioId: number | null, audience: string, title = "Pulse test") => ({
      title, body: "A scoped message", priority: "info", audience, studioId,
    });
    const publish = async (staff: typeof district, studioId: number | null, audience: string, title: string) => {
      const result = await api(user(staff), "POST", "/pulse", draft(studioId, audience, title));
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.studioId, studioId);
      assert.equal(result.body.audience, audience);
      assert.equal(result.body.isRead, true);
      assert.equal(result.body.readCount, 1);
      return result.body.id as number;
    };
    const list = async (staff: typeof district) => {
      const result = await api(user(staff), "GET", "/pulse");
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body as Array<{ id: number; isRead: boolean; readCount: number }>;
    };

    await t.test("unauthenticated and employee publishing is denied", async () => {
      assert.equal((await api(null, "GET", "/pulse")).status, 401);
      assert.equal((await api(null, "POST", "/pulse", draft(studioA.id, "all"))).status, 401);
      assert.equal((await api(user(employeeA), "POST", "/pulse", draft(studioA.id, "all"))).status, 403);
    });

    await t.test("managers publish only to their own studio; districts cannot cross organizations", async () => {
      assert.equal((await api(user(managerA), "POST", "/pulse", draft(null, "all"))).status, 403);
      assert.equal((await api(user(managerA), "POST", "/pulse", draft(studioB.id, "all"))).status, 403);
      assert.equal((await api(user(managerA), "POST", "/pulse", draft(studioOther.id, "all"))).status, 403);
      assert.equal((await api(user(district), "POST", "/pulse", draft(studioOther.id, "all"))).status, 403);
      assert.equal((await api(user(otherDistrict), "POST", "/pulse", draft(studioA.id, "all"))).status, 403);
    });

    const global = await publish(district, null, "all", "Org A global");
    const managers = await publish(district, null, "managers", "Org A managers");
    const employees = await publish(district, studioA.id, "employees", "Studio A employees");
    const studioAAll = await publish(managerA, studioA.id, "all", "Studio A all");
    const studioBAll = await publish(managerB, studioB.id, "all", "Studio B all");
    const other = await publish(otherDistrict, null, "all", "Org B only");
    const foreign = new Set([other]);

    await t.test("listing isolates organizations, studios, audiences and author visibility", async () => {
      const aEmployee = await list(employeeA);
      assert.deepEqual(new Set(aEmployee.map((m) => m.id)), new Set([global, employees, studioAAll]));
      const bEmployee = await list(employeeB);
      assert.deepEqual(new Set(bEmployee.map((m) => m.id)), new Set([global, studioBAll]));
      const aManager = await list(managerA);
      assert.deepEqual(new Set(aManager.map((m) => m.id)), new Set([global, managers, studioAAll]));
      const bManager = await list(managerB);
      assert.deepEqual(new Set(bManager.map((m) => m.id)), new Set([global, managers, studioBAll]));
      const aDistrict = await list(district);
      assert.deepEqual(new Set(aDistrict.map((m) => m.id)), new Set([global, managers, employees, studioAAll, studioBAll]));
      assert.deepEqual(new Set((await list(otherDistrict)).map((m) => m.id)), foreign);
      assert.equal(aDistrict.find((m) => m.id === global)?.isRead, true);
      assert.equal(aEmployee.find((m) => m.id === global)?.isRead, false);

      const ownEmployees = await publish(managerA, studioA.id, "employees", "Manager-authored employee note");
      assert.ok((await list(managerA)).some((m) => m.id === ownEmployees));
      assert.ok((await list(employeeA)).some((m) => m.id === ownEmployees));
      assert.ok(!(await list(managerB)).some((m) => m.id === ownEmployees));
    });

    await t.test("read endpoints reject invisible messages without creating receipts", async () => {
      for (const [staff, id] of [
        [employeeA, managers],
        [employeeA, studioBAll],
        [managerA, employees],
        [managerA, studioBAll],
        [district, other],
        [otherDistrict, global],
      ] as const) {
        assert.equal((await api(user(staff), "POST", `/pulse/${id}/read`)).status, 404);
        const reads = await db.select().from(pulseReadsTable)
          .where(and(eq(pulseReadsTable.messageId, id), eq(pulseReadsTable.staffId, staff.id)));
        assert.equal(reads.length, 0);
      }
      assert.equal((await api(null, "POST", `/pulse/${global}/read`)).status, 401);
    });

    await t.test("read receipts are personal, scoped and idempotent", async () => {
      const first = await api(user(employeeA), "POST", `/pulse/${global}/read`);
      const second = await api(user(employeeA), "POST", `/pulse/${global}/read`);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(first.body.messageId, global);
      assert.equal(second.body.readAt, first.body.readAt);
      const reads = await db.select().from(pulseReadsTable)
        .where(and(eq(pulseReadsTable.messageId, global), eq(pulseReadsTable.staffId, employeeA.id)));
      assert.equal(reads.length, 1);
      assert.equal((await list(employeeA)).find((m) => m.id === global)?.readCount, 2);
      assert.equal((await list(employeeA)).find((m) => m.id === global)?.isRead, true);
      assert.equal((await list(employeeB)).find((m) => m.id === global)?.isRead, false);
      assert.equal((await list(employeeB)).find((m) => m.id === global)?.readCount, 2);
      assert.equal((await list(otherDistrict)).some((m) => m.id === global), false);
    });

    assert.equal((await db.select().from(pulseMessagesTable).where(eq(pulseMessagesTable.organizationId, orgB.id))).length, 1);
  } finally {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    for (const id of organizations) await db.delete(organizationsTable).where(eq(organizationsTable.id, id));
    await pool.end();
  }
});