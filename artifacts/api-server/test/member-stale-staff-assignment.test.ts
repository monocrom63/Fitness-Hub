import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import express from "express";
import {
  db,
  membersTable,
  organizationsTable,
  pool,
  staffTable,
  studiosTable,
} from "@workspace/db";
import portalRouter from "../src/routes/portal";

test("a staff assignment to another organization's studio grants no member access", async () => {
  const run = randomUUID();
  const organizationIds: number[] = [];
  const studioIds: number[] = [];
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;

  try {
    const [orgA] = await db.insert(organizationsTable)
      .values({ name: `Stale member assignment A ${run}` }).returning();
    organizationIds.push(orgA.id);
    const [orgB] = await db.insert(organizationsTable)
      .values({ name: `Stale member assignment B ${run}` }).returning();
    organizationIds.push(orgB.id);

    const [studioA1, studioA2, studioB] = await db.insert(studiosTable).values([
      { organizationId: orgA.id, name: `Stale assignment A1 ${run}`, city: "Berlin" },
      { organizationId: orgA.id, name: `Stale assignment A2 ${run}`, city: "Potsdam" },
      { organizationId: orgB.id, name: `Stale assignment B ${run}`, city: "Hamburg" },
    ]).returning();
    studioIds.push(studioA1.id, studioA2.id, studioB.id);

    const users = {
      mismatchedManager: `stale-manager-${run}`,
      mismatchedDistrict: `stale-district-${run}`,
      managerA: `valid-manager-a-${run}`,
      districtA: `valid-district-a-${run}`,
      managerB: `valid-manager-b-${run}`,
      districtB: `valid-district-b-${run}`,
    };
    const [mismatchedManager, mismatchedDistrict, managerA, districtA, managerB, districtB] =
      await db.insert(staffTable).values([
        { clerkUserId: users.mismatchedManager, organizationId: orgA.id, studioId: studioB.id, fullName: "Mismatched manager", email: `mismatched-manager-${run}@example.invalid`, role: "studio_manager" },
        { clerkUserId: users.mismatchedDistrict, organizationId: orgA.id, studioId: studioB.id, fullName: "Mismatched district manager", email: `mismatched-district-${run}@example.invalid`, role: "district_manager" },
        { clerkUserId: users.managerA, organizationId: orgA.id, studioId: studioA1.id, fullName: "Manager A", email: `manager-a-${run}@example.invalid`, role: "studio_manager" },
        { clerkUserId: users.districtA, organizationId: orgA.id, studioId: null, fullName: "District A", email: `district-a-${run}@example.invalid`, role: "district_manager" },
        { clerkUserId: users.managerB, organizationId: orgB.id, studioId: studioB.id, fullName: "Manager B", email: `manager-b-${run}@example.invalid`, role: "studio_manager" },
        { clerkUserId: users.districtB, organizationId: orgB.id, studioId: null, fullName: "District B", email: `district-b-${run}@example.invalid`, role: "district_manager" },
      ]).returning();

    const [memberA1, memberA2, memberB] = await db.insert(membersTable).values([
      { studioId: studioA1.id, fullName: "Member A1", email: `member-a1-${run}@example.invalid`, membershipType: "Standard" },
      { studioId: studioA2.id, fullName: "Member A2", email: `member-a2-${run}@example.invalid`, membershipType: "Standard" },
      { studioId: studioB.id, fullName: "Member B", email: `member-b-${run}@example.invalid`, membershipType: "Standard" },
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

    async function api(user: string, method: "GET" | "POST", path: string, data?: unknown) {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          "x-test-user": user,
          ...(data === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      return { status: response.status, body: await response.json() as any };
    }
    const memberIds = (rows: Array<{ id: number }>) =>
      rows.map((row) => row.id).sort((a, b) => a - b);
    const draft = (studioId: number, label: string) => ({
      studioId,
      fullName: `Created ${label}`,
      email: `${label}-${run}@example.invalid`,
      membershipType: "Standard",
    });

    // The stale studio_manager assignment fails closed for both unfiltered and
    // explicitly filtered listing, and cannot insert into the foreign studio.
    assert.deepEqual((await api(mismatchedManager.clerkUserId, "GET", "/members")).body, []);
    assert.equal(
      (await api(mismatchedManager.clerkUserId, "GET", `/members?studioId=${studioB.id}`)).status,
      403,
    );
    const rejectedManagerCreate = await api(
      mismatchedManager.clerkUserId,
      "POST",
      "/members",
      draft(studioB.id, "rejected-manager"),
    );
    assert.equal(rejectedManagerCreate.status, 403);

    // District scope follows organizationId, not the inconsistent studioId:
    // it can see A's studios, but cannot list or create a member in B.
    assert.deepEqual(
      memberIds((await api(mismatchedDistrict.clerkUserId, "GET", "/members")).body),
      [memberA1.id, memberA2.id].sort((a, b) => a - b),
    );
    assert.equal(
      (await api(mismatchedDistrict.clerkUserId, "GET", `/members?studioId=${studioB.id}`)).status,
      403,
    );
    const rejectedDistrictCreate = await api(
      mismatchedDistrict.clerkUserId,
      "POST",
      "/members",
      draft(studioB.id, "rejected-district"),
    );
    assert.equal(rejectedDistrictCreate.status, 403);

    // Valid controls confirm the expected role distinction: district managers
    // span their organization while studio managers remain in their assigned studio.
    assert.deepEqual(
      memberIds((await api(districtA.clerkUserId, "GET", "/members")).body),
      [memberA1.id, memberA2.id].sort((a, b) => a - b),
    );
    assert.deepEqual(
      memberIds((await api(managerA.clerkUserId, "GET", "/members")).body),
      [memberA1.id],
    );
    assert.deepEqual(
      memberIds((await api(districtB.clerkUserId, "GET", "/members")).body),
      [memberB.id],
    );
    assert.deepEqual(
      memberIds((await api(managerB.clerkUserId, "GET", "/members")).body),
      [memberB.id],
    );

    const managerOwnCreate = await api(
      managerA.clerkUserId,
      "POST",
      "/members",
      draft(studioA1.id, "valid-manager-a"),
    );
    assert.equal(managerOwnCreate.status, 201);
    const districtOrgCreate = await api(
      districtA.clerkUserId,
      "POST",
      "/members",
      draft(studioA2.id, "valid-district-a"),
    );
    assert.equal(districtOrgCreate.status, 201);
    const managerBCreate = await api(
      managerB.clerkUserId,
      "POST",
      "/members",
      draft(studioB.id, "valid-manager-b"),
    );
    assert.equal(managerBCreate.status, 201);
    assert.equal(managerBCreate.body.studioId, studioB.id);

    const fixtureEmails = [
      `rejected-manager-${run}@example.invalid`,
      `rejected-district-${run}@example.invalid`,
      `valid-manager-a-${run}@example.invalid`,
      `valid-district-a-${run}@example.invalid`,
      `valid-manager-b-${run}@example.invalid`,
    ];
    const persistedFixtures = await db.select({ email: membersTable.email })
      .from(membersTable).where(inArray(membersTable.email, fixtureEmails));
    assert.deepEqual(
      persistedFixtures.map((row) => row.email).sort(),
      fixtureEmails.slice(2).sort(),
      "forbidden creates must not persist, while valid controls should",
    );
  } finally {
    try {
      if (server?.listening) {
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => error ? reject(error) : resolve()),
        );
      }
    } finally {
      if (studioIds.length) {
        await db.delete(membersTable).where(inArray(membersTable.studioId, studioIds));
      }
      await db.delete(staffTable).where(inArray(staffTable.clerkUserId, [
        `stale-manager-${run}`,
        `stale-district-${run}`,
        `valid-manager-a-${run}`,
        `valid-district-a-${run}`,
        `valid-manager-b-${run}`,
        `valid-district-b-${run}`,
      ]));
      for (const id of organizationIds) {
        await db.delete(organizationsTable).where(eq(organizationsTable.id, id));
      }
      await pool.end();
    }
  }
});