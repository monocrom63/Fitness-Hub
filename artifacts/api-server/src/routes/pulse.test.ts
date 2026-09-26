import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { and, count, eq } from "drizzle-orm";
import express from "express";
import {
  db,
  organizationsTable,
  pool,
  pulseMessagesTable,
  pulseReadsTable,
  staffTable,
  studiosTable,
} from "@workspace/db";
import { createPulseRouter } from "./pulse";

after(async () => {
  await pool.end();
});

const rollback = new Error("Roll back Pulse test fixtures");

test("Pulse enforces role, organization, studio and read-receipt boundaries", async (t) => {
  try {
    await db.transaction(async (tx) => {
      const suffix = randomUUID();
      const [orgA] = await tx
        .insert(organizationsTable)
        .values({ name: `Pulse test A ${suffix}` })
        .returning();
      const [orgB] = await tx
        .insert(organizationsTable)
        .values({ name: `Pulse test B ${suffix}` })
        .returning();
      const [studioA1] = await tx
        .insert(studiosTable)
        .values({ organizationId: orgA.id, name: "A1", city: "Berlin" })
        .returning();
      const [studioA2] = await tx
        .insert(studiosTable)
        .values({ organizationId: orgA.id, name: "A2", city: "Berlin" })
        .returning();
      const [studioB1] = await tx
        .insert(studiosTable)
        .values({ organizationId: orgB.id, name: "B1", city: "Hamburg" })
        .returning();

      const users = {
        districtA: `pulse-test-district-a-${suffix}`,
        districtB: `pulse-test-district-b-${suffix}`,
        managerA1: `pulse-test-manager-a1-${suffix}`,
        managerA2: `pulse-test-manager-a2-${suffix}`,
        managerB1: `pulse-test-manager-b1-${suffix}`,
        employeeA1: `pulse-test-employee-a1-${suffix}`,
        employeeA2: `pulse-test-employee-a2-${suffix}`,
      };
      const staff = await tx
        .insert(staffTable)
        .values(
          Object.entries(users).map(([key, clerkUserId]) => ({
            clerkUserId,
            organizationId: key.endsWith("B") || key === "managerB1" ? orgB.id : orgA.id,
            studioId:
              key === "districtB" || key === "managerB1"
                ? studioB1.id
                : key.endsWith("A2")
                  ? studioA2.id
                  : studioA1.id,
            fullName: key,
            email: `${key}-${suffix}@example.invalid`,
            role: key.startsWith("district")
              ? "district_manager"
              : key.startsWith("manager")
                ? "studio_manager"
                : "studio_employee",
          })),
        )
        .returning();
      const staffByKey = new Map(staff.map((row) => [row.fullName, row]));
      const authorA = staffByKey.get("districtA")!;
      const authorB = staffByKey.get("districtB")!;

      const entries = [
        { title: "Org alle", organizationId: orgA.id, studioId: null, audience: "all", authorStaffId: authorA.id },
        { title: "Org Leitung", organizationId: orgA.id, studioId: null, audience: "managers", authorStaffId: authorA.id },
        { title: "Org Team", organizationId: orgA.id, studioId: null, audience: "employees", authorStaffId: authorA.id },
        { title: "A1 alle", organizationId: orgA.id, studioId: studioA1.id, audience: "all", authorStaffId: authorA.id },
        { title: "A1 Leitung", organizationId: orgA.id, studioId: studioA1.id, audience: "managers", authorStaffId: authorA.id },
        { title: "A1 Team", organizationId: orgA.id, studioId: studioA1.id, audience: "employees", authorStaffId: authorA.id },
        { title: "A2 alle", organizationId: orgA.id, studioId: studioA2.id, audience: "all", authorStaffId: authorA.id },
        { title: "B1 alle", organizationId: orgB.id, studioId: studioB1.id, audience: "all", authorStaffId: authorB.id },
      ] as const;
      const seeded = await tx
        .insert(pulseMessagesTable)
        .values(entries.map((entry) => ({ ...entry, body: "Pulse test content", priority: "important" })))
        .returning();
      const messages = new Map(seeded.map((row) => [row.title, row]));

      const app = express();
      app.use(express.json());
      // Only this in-process router accepts the test header. The production router still uses Clerk.
      app.use(
        "/api",
        createPulseRouter({
          database: tx as unknown as typeof db,
          userIdFromRequest: (req) => req.get("x-test-user") ?? null,
        }),
      );
      const server = app.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}/api`;
      type PulseRow = {
        id: number;
        title: string;
        authorName: string;
        isRead: boolean;
        readCount: number;
      };
      async function call<T = unknown>(
        user: string | null,
        path: string,
        method = "GET",
        body?: unknown,
      ) {
        const headers: Record<string, string> = {};
        if (user) headers["x-test-user"] = user;
        if (body !== undefined) headers["content-type"] = "application/json";
        const response = await fetch(`${origin}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, data: await response.json() as T };
      }
      async function list(user: string) {
        const response = await call<PulseRow[]>(user, "/pulse");
        assert.equal(response.status, 200);
        return response.data;
      }
      const draft = (studioId: number | null, audience = "all") => ({
        title: "Neue Nachricht",
        body: "Hinweis für das Team",
        priority: "important",
        audience,
        studioId,
      });
      const titles = (data: Array<{ title: string }>) =>
        data.map((message) => message.title).sort();

      try {
        await t.test("requires a signed-in, assigned staff member", async () => {
          assert.equal((await call(null, "/pulse")).status, 401);
          assert.equal((await call(null, "/pulse", "POST", draft(studioA1.id))).status, 401);
          assert.equal((await call(null, `/pulse/${messages.get("Org alle")!.id}/read`, "POST")).status, 401);
          assert.equal((await call("unknown-test-user", "/pulse")).status, 403);
        });

        await t.test("lists only visible messages for each role, studio and organization", async () => {
          const expected = [
            [users.employeeA1, ["Org alle", "Org Team", "A1 alle", "A1 Team"]],
            [users.employeeA2, ["Org alle", "Org Team", "A2 alle"]],
            [users.managerA1, ["Org alle", "Org Leitung", "A1 alle", "A1 Leitung"]],
            [users.managerA2, ["Org alle", "Org Leitung", "A2 alle"]],
            [users.managerB1, ["B1 alle"]],
            [users.districtA, entries.filter((entry) => entry.organizationId === orgA.id).map((entry) => entry.title)],
            [users.districtB, ["B1 alle"]],
          ] as const;
          for (const [user, visible] of expected) {
            assert.deepEqual(titles(await list(user)), [...visible].sort(), user);
          }
        });

        await t.test("rejects unauthorized publishing and retains author visibility", async () => {
          assert.equal((await call(users.employeeA1, "/pulse", "POST", draft(studioA1.id))).status, 403);
          assert.equal((await call(users.managerA1, "/pulse", "POST", draft(null))).status, 403);
          assert.equal((await call(users.managerA1, "/pulse", "POST", draft(studioA2.id))).status, 403);
          assert.equal((await call(users.managerA1, "/pulse", "POST", draft(studioB1.id))).status, 403);
          assert.equal((await call(users.districtA, "/pulse", "POST", draft(studioB1.id))).status, 403);

          const employeeNotice = await call<PulseRow>(users.managerA1, "/pulse", "POST", draft(studioA1.id, "employees"));
          assert.equal(employeeNotice.status, 201);
          assert.equal(employeeNotice.data.isRead, true);
          assert.equal(employeeNotice.data.readCount, 1);
          assert.equal(
            (await list(users.managerA1)).some((message) => message.id === employeeNotice.data.id),
            true,
          );
          assert.equal(
            (await list(users.employeeA1)).some((message) => message.id === employeeNotice.data.id),
            true,
          );
          assert.equal(
            (await list(users.employeeA2)).some((message) => message.id === employeeNotice.data.id),
            false,
          );
          assert.equal((await call(users.districtA, "/pulse", "POST", draft(null))).status, 201);
          assert.equal((await call(users.districtA, "/pulse", "POST", draft(studioA2.id))).status, 201);
          assert.equal((await call(users.districtB, "/pulse", "POST", draft(null))).status, 201);
          assert.equal(
            (await list(users.districtA)).some((message) => message.authorName === "districtB"),
            false,
          );
        });

        await t.test("records a visible message once and rejects hidden read receipts", async () => {
          const hiddenIds = ["Org Leitung", "A2 alle", "B1 alle"].map((title) => messages.get(title)!.id);
          for (const id of hiddenIds) {
            assert.equal((await call(users.employeeA1, `/pulse/${id}/read`, "POST")).status, 404);
          }
          assert.equal((await call(users.managerA1, `/pulse/${messages.get("Org Team")!.id}/read`, "POST")).status, 404);
          assert.equal((await call(users.managerA1, `/pulse/${messages.get("A2 alle")!.id}/read`, "POST")).status, 404);
          assert.equal((await call(users.districtA, `/pulse/${messages.get("B1 alle")!.id}/read`, "POST")).status, 404);
          assert.equal((await call(users.employeeA1, "/pulse/999999999/read", "POST")).status, 404);
          const id = messages.get("Org Team")!.id;
          const first = await call<{ messageId: number; readAt: string }>(users.employeeA1, `/pulse/${id}/read`, "POST");
          const second = await call<{ messageId: number; readAt: string }>(users.employeeA1, `/pulse/${id}/read`, "POST");
          assert.equal(first.status, 200);
          assert.equal(second.status, 200);
          assert.equal(first.data.messageId, id);
          assert.equal(second.data.readAt, first.data.readAt);
          const [receipt] = await tx
            .select({ total: count() })
            .from(pulseReadsTable)
            .where(
              and(
                eq(pulseReadsTable.messageId, id),
                eq(pulseReadsTable.staffId, staffByKey.get("employeeA1")!.id),
              ),
            );
          assert.equal(receipt.total, 1);
          const readMessage = (await list(users.employeeA1)).find((message) => message.id === id);
          assert.ok(readMessage);
          assert.equal(readMessage.isRead, true);
          assert.equal(readMessage.readCount, 1);
          const hiddenReceipts = await tx
            .select({ id: pulseReadsTable.id })
            .from(pulseReadsTable)
            .where(eq(pulseReadsTable.staffId, staffByKey.get("employeeA1")!.id));
          assert.equal(hiddenReceipts.length, 1);
        });
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
});