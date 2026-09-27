import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import {
  coursesTable,
  db,
  organizationsTable,
  pool,
  staffTable,
  studiosTable,
} from "@workspace/db";
import portalRouter from "../src/routes/portal";

test("district managers can edit studios and choose an authorized studio context", async () => {
  const run = randomUUID();
  const organizationIds: number[] = [];
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;

  try {
    const [organization] = await db.insert(organizationsTable)
      .values({ name: `Studio context ${run}` }).returning();
    organizationIds.push(organization.id);
    const [foreignOrganization] = await db.insert(organizationsTable)
      .values({ name: `Foreign studio context ${run}` }).returning();
    organizationIds.push(foreignOrganization.id);
    const [studioA, studioB, foreignStudio] = await db.insert(studiosTable).values([
      { organizationId: organization.id, name: `North ${run}`, city: "Berlin" },
      { organizationId: organization.id, name: `South ${run}`, city: "Hamburg" },
      { organizationId: foreignOrganization.id, name: `Foreign ${run}`, city: "Cologne" },
    ]).returning();
    const [district, manager, staleManager] = await db.insert(staffTable).values([
      { clerkUserId: `studio-context-district-${run}`, organizationId: organization.id, studioId: null, fullName: "District", email: `district-${run}@example.invalid`, role: "district_manager" },
      { clerkUserId: `studio-context-manager-${run}`, organizationId: organization.id, studioId: studioA.id, fullName: "Manager", email: `manager-${run}@example.invalid`, role: "studio_manager" },
      { clerkUserId: `studio-context-stale-${run}`, organizationId: organization.id, studioId: foreignStudio.id, fullName: "Stale manager", email: `stale-${run}@example.invalid`, role: "studio_manager" },
    ]).returning();

    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.insert(coursesTable).values([
      { studioId: studioA.id, title: `Course A ${run}`, instructor: "Instructor", startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000), capacity: 10, room: "A" },
      { studioId: studioB.id, title: `Course B ${run}`, instructor: "Instructor", startsAt: new Date(startsAt.getTime() + 60 * 60 * 1000), endsAt: new Date(startsAt.getTime() + 2 * 60 * 60 * 1000), capacity: 10, room: "B" },
      { studioId: foreignStudio.id, title: `Foreign course ${run}`, instructor: "Instructor", startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000), capacity: 10, room: "C" },
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
    app.use("/api", portalRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    async function api(user: string | null, method: string, path: string, data?: unknown) {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          ...(user ? { "x-test-user": user } : {}),
          ...(data === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      return { status: response.status, body: await response.json() as any };
    }
    const updatePath = `/studios/${studioA.id}`;
    const draft = { name: `Renamed ${run}`, city: "  Potsdam  " };

    assert.equal((await api(manager.clerkUserId, "PATCH", updatePath, draft)).status, 403);
    assert.equal((await api(district.clerkUserId, "PATCH", `/studios/${foreignStudio.id}`, draft)).status, 404);
    assert.equal((await api(district.clerkUserId, "PATCH", `/studios/${studioA.id}`, { name: " ", city: "Berlin" })).status, 400);
    assert.equal((await api(district.clerkUserId, "PATCH", "/studios/not-an-id", draft)).status, 400);

    const updated = await api(district.clerkUserId, "PATCH", updatePath, draft);
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.deepEqual(updated.body, { id: studioA.id, name: draft.name, city: "Potsdam" });
    const [stored] = await db.select().from(studiosTable).where(eq(studiosTable.id, studioA.id));
    assert.equal(stored.organizationId, organization.id);

    assert.equal((await api(district.clerkUserId, "PATCH", `/studios/${studioB.id}`, {
      name: `  RENAMED ${run} `, city: "POTSDAM",
    })).status, 409, "duplicate checks trim and ignore case");

    const allCourses = await api(district.clerkUserId, "GET", "/courses");
    const filteredCourses = await api(district.clerkUserId, "GET", `/courses?studioId=${studioB.id}`);
    assert.equal(allCourses.status, 200);
    assert.equal(filteredCourses.status, 200);
    assert.ok(allCourses.body.some((course: any) => course.studioId === studioA.id));
    assert.deepEqual(filteredCourses.body.map((course: any) => course.studioId), [studioB.id]);
    const filteredDashboard = await api(district.clerkUserId, "GET", `/dashboard?studioId=${studioB.id}`);
    assert.equal(filteredDashboard.status, 200);
    assert.equal(filteredDashboard.body.studioName, studioB.name);
    assert.ok(filteredDashboard.body.courses.length > 0);
    assert.ok(filteredDashboard.body.courses.every((course: any) => course.studioId === studioB.id));
    assert.equal((await api(manager.clerkUserId, "GET", `/courses?studioId=${studioB.id}`)).status, 403);
    assert.equal((await api(district.clerkUserId, "GET", `/dashboard?studioId=${foreignStudio.id}`)).status, 403);

    assert.deepEqual((await api(staleManager.clerkUserId, "GET", "/courses")).body, []);
    assert.equal((await api(staleManager.clerkUserId, "GET", `/courses?studioId=${foreignStudio.id}`)).status, 403);
    const staleDashboard = await api(staleManager.clerkUserId, "GET", `/dashboard?studioId=${studioA.id}`);
    assert.equal(staleDashboard.status, 403);
    assert.deepEqual((await api(staleManager.clerkUserId, "GET", "/dashboard")).body.courses, []);

    const concurrent = await Promise.all([
      api(district.clerkUserId, "PATCH", `/studios/${studioA.id}`, { name: `Concurrent ${run}`, city: "Berlin" }),
      api(district.clerkUserId, "PATCH", `/studios/${studioB.id}`, { name: ` concurrent ${run} `, city: " berlin " }),
    ]);
    assert.deepEqual(concurrent.map(({ status }) => status).sort(), [200, 409]);
    const organizationStudios = await db.select({ name: studiosTable.name, city: studiosTable.city })
      .from(studiosTable).where(eq(studiosTable.organizationId, organization.id));
    assert.equal(organizationStudios.filter((studio) =>
      studio.name.trim().toLowerCase() === `concurrent ${run}`.toLowerCase() &&
      studio.city.trim().toLowerCase() === "berlin").length, 1);
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