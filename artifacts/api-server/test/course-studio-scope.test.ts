import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import express from "express";
import {
  coursesTable,
  db,
  organizationsTable,
  pool,
  staffTable,
  studiosTable,
} from "@workspace/db";
import portalRouter from "../src/routes/portal";

test("course reads and district course creation stay within explicitly targeted studios", async () => {
  const run = randomUUID();
  const organizationIds: number[] = [];
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;

  try {
    const [organization, foreignOrganization] = await db.insert(organizationsTable).values([
      { name: `Course scope ${run}` },
      { name: `Foreign course scope ${run}` },
    ]).returning();
    organizationIds.push(organization.id, foreignOrganization.id);

    const [studioA, studioB, foreignStudio] = await db.insert(studiosTable).values([
      { organizationId: organization.id, name: `Course scope A ${run}`, city: "Berlin" },
      { organizationId: organization.id, name: `Course scope B ${run}`, city: "Hamburg" },
      { organizationId: foreignOrganization.id, name: `Foreign course scope ${run}`, city: "Köln" },
    ]).returning();

    const [district, managerA] = await db.insert(staffTable).values([
      {
        clerkUserId: `course-scope-district-${run}`,
        organizationId: organization.id,
        studioId: null,
        fullName: "District Manager",
        email: `course-scope-district-${run}@example.invalid`,
        role: "district_manager",
      },
      {
        clerkUserId: `course-scope-manager-${run}`,
        organizationId: organization.id,
        studioId: studioA.id,
        fullName: "Studio Manager",
        email: `course-scope-manager-${run}@example.invalid`,
        role: "studio_manager",
      },
    ]).returning();

    const startsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    const seededCourses = await db.insert(coursesTable).values([
      {
        studioId: studioA.id,
        title: `Seed A ${run}`,
        instructor: `Seed instructor A ${run}`,
        startsAt,
        endsAt,
        capacity: 10,
        room: `Seed room A ${run}`,
      },
      {
        studioId: studioB.id,
        title: `Seed B ${run}`,
        instructor: `Seed instructor B ${run}`,
        startsAt,
        endsAt,
        capacity: 10,
        room: `Seed room B ${run}`,
      },
      {
        studioId: foreignStudio.id,
        title: `Seed foreign ${run}`,
        instructor: `Seed instructor foreign ${run}`,
        startsAt,
        endsAt,
        capacity: 10,
        room: `Seed room foreign ${run}`,
      },
    ]).returning();

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

    async function api(userId: string, method: string, path: string, data?: unknown) {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          "x-test-user": userId,
          ...(data === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      return { status: response.status, body: await response.json() as any };
    }

    async function createCourse(studioId: number, suffix: string) {
      return api(district.clerkUserId, "POST", "/courses", {
        studioId,
        title: `District target ${suffix} ${run}`,
        instructor: `District instructor ${suffix} ${run}`,
        startsAt: new Date(startsAt.getTime() + 60 * 60 * 1000).toISOString(),
        endsAt: new Date(endsAt.getTime() + 60 * 60 * 1000).toISOString(),
        capacity: 12,
        room: `District room ${suffix} ${run}`,
      });
    }

    const createdA = await createCourse(studioA.id, "A");
    const createdB = await createCourse(studioB.id, "B");
    assert.equal(createdA.status, 201, JSON.stringify(createdA.body));
    assert.equal(createdB.status, 201, JSON.stringify(createdB.body));
    assert.equal(createdA.body.studioId, studioA.id);
    assert.equal(createdB.body.studioId, studioB.id);

    for (const [studio, created, seeded] of [
      [studioA, createdA, seededCourses[0]!],
      [studioB, createdB, seededCourses[1]!],
    ] as const) {
      const filtered = await api(district.clerkUserId, "GET", `/courses?studioId=${studio.id}`);
      assert.equal(filtered.status, 200);
      assert.ok(filtered.body.length > 0);
      assert.ok(filtered.body.every((course: any) => course.studioId === studio.id));
      assert.ok(filtered.body.some((course: any) => course.id === seeded.id));
      assert.ok(filtered.body.some((course: any) => course.id === created.body.id));
    }

    const districtCourses = await api(district.clerkUserId, "GET", "/courses");
    assert.equal(districtCourses.status, 200);
    assert.ok(districtCourses.body.every((course: any) => course.studioId !== foreignStudio.id));

    const managerOwnStudio = await api(managerA.clerkUserId, "GET", `/courses?studioId=${studioA.id}`);
    assert.equal(managerOwnStudio.status, 200);
    assert.ok(managerOwnStudio.body.length > 0);
    assert.ok(managerOwnStudio.body.every((course: any) => course.studioId === studioA.id));
    assert.equal((await api(managerA.clerkUserId, "GET", `/courses?studioId=${studioB.id}`)).status, 403);
    assert.equal((await api(district.clerkUserId, "GET", `/courses?studioId=${foreignStudio.id}`)).status, 403);

    const managerCrossStudioCreate = await api(managerA.clerkUserId, "POST", "/courses", {
      studioId: studioB.id,
      title: `Unauthorized target ${run}`,
      instructor: `Unauthorized instructor ${run}`,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      capacity: 10,
      room: `Unauthorized room ${run}`,
    });
    assert.equal(managerCrossStudioCreate.status, 403);

    const districtForeignCreate = await api(district.clerkUserId, "POST", "/courses", {
      studioId: foreignStudio.id,
      title: `Foreign target ${run}`,
      instructor: `Foreign instructor ${run}`,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      capacity: 10,
      room: `Foreign room ${run}`,
    });
    assert.equal(districtForeignCreate.status, 403);

    const [persistedA] = await db.select().from(coursesTable).where(eq(coursesTable.id, createdA.body.id));
    const [persistedB] = await db.select().from(coursesTable).where(eq(coursesTable.id, createdB.body.id));
    assert.equal(persistedA.studioId, studioA.id);
    assert.equal(persistedB.studioId, studioB.id);
    const [unauthorizedCourse] = await db.select().from(coursesTable)
      .where(eq(coursesTable.title, `Unauthorized target ${run}`));
    assert.equal(unauthorizedCourse, undefined);
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