import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import express from "express";
import {
  db,
  organizationModulesTable,
  organizationsTable,
  pool,
  staffTable,
  studiosTable,
} from "@workspace/db";
import { createModulesRouter } from "./modules";
import { isModuleEnabled } from "../lib/module-access";

after(async () => {
  await pool.end();
});

const rollback = new Error("Roll back module test fixtures");

test("organization module defaults, overrides and role restrictions", async (t) => {
  try {
    await db.transaction(async (tx) => {
      const suffix = randomUUID();
      const [organization] = await tx
        .insert(organizationsTable)
        .values({ name: `Module test ${suffix}` })
        .returning();
      const [studio] = await tx
        .insert(studiosTable)
        .values({
          organizationId: organization.id,
          name: "Test studio",
          city: "Berlin",
        })
        .returning();
      const districtId = `module-district-${suffix}`;
      const employeeId = `module-employee-${suffix}`;
      await tx.insert(staffTable).values([
        {
          clerkUserId: districtId,
          organizationId: organization.id,
          studioId: studio.id,
          fullName: "Test district manager",
          email: `${districtId}@example.invalid`,
          role: "district_manager",
        },
        {
          clerkUserId: employeeId,
          organizationId: organization.id,
          studioId: studio.id,
          fullName: "Test employee",
          email: `${employeeId}@example.invalid`,
          role: "studio_employee",
        },
      ]);

      const database = tx as unknown as typeof db;
      assert.equal(await isModuleEnabled(organization.id, "members", database), true);

      const app = express();
      app.use(express.json());
      app.use(
        "/api",
        createModulesRouter({
          database,
          userIdFromRequest: (req) => req.get("x-test-user") ?? null,
        }),
      );
      const server = app.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}/api`;

      async function call(
        user: string,
        path: string,
        method = "GET",
        body?: unknown,
      ) {
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: {
            "x-test-user": user,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, data: await response.json() as unknown };
      }

      try {
        await t.test("lists missing overrides as enabled", async () => {
          const response = await call(districtId, "/modules");
          assert.equal(response.status, 200);
          assert.deepEqual(
            (response.data as Array<{ key: string; enabled: boolean }>).map(
              ({ key, enabled }) => [key, enabled],
            ),
            [
              ["members", true],
              ["courses", true],
              ["pulse", true],
              ["team", true],
            ],
          );
        });

        await t.test("district manager can upsert while employees cannot", async () => {
          assert.equal(
            (await call(employeeId, "/modules/members", "PATCH", { enabled: false }))
              .status,
            403,
          );
          const updated = await call(
            districtId,
            "/modules/members",
            "PATCH",
            { enabled: false },
          );
          assert.equal(updated.status, 200);
          assert.deepEqual(updated.data, {
            key: "members",
            title: "Mitglieder",
            enabled: false,
          });
          assert.equal(await isModuleEnabled(organization.id, "members", database), false);

          const [override] = await tx
            .select()
            .from(organizationModulesTable)
            .where(eq(organizationModulesTable.organizationId, organization.id));
          assert.equal(override.key, "members");
          assert.equal(override.enabled, 0);
          assert.equal((await call(employeeId, "/modules")).status, 200);
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