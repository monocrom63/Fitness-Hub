import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import express from "express";
import { clerkMiddleware } from "@clerk/express";
import {
  db,
  invitationsTable,
  organizationsTable,
  pool,
  staffTable,
  studiosTable,
} from "@workspace/db";
import { createTeamRouter } from "../src/routes/team";
import { createApiRouter } from "../src/routes";

after(async () => {
  await pool.end();
});

const rollback = new Error("Roll back team invitation fixtures");
type Invitation = {
  id: number;
  email: string;
  role: string;
  studioId: number;
  status: string;
  inviteUrl: string;
};

test("team invitations cannot be sent to or accepted for the wrong studio", async (t) => {
  try {
    await db.transaction(async (tx) => {
      const run = randomUUID();
      const [orgA] = await tx.insert(organizationsTable)
        .values({ name: `Team test A ${run}` }).returning();
      const [orgB] = await tx.insert(organizationsTable)
        .values({ name: `Team test B ${run}` }).returning();
      const [studioA1, studioA2, studioB] = await tx.insert(studiosTable).values([
        { organizationId: orgA.id, name: "A1", city: "Berlin" },
        { organizationId: orgA.id, name: "A2", city: "Berlin" },
        { organizationId: orgB.id, name: "B", city: "Hamburg" },
      ]).returning();
      const users = {
        districtA: `team-district-a-${run}`,
        managerA1: `team-manager-a1-${run}`,
        managerA2: `team-manager-a2-${run}`,
        employeeA1: `team-employee-a1-${run}`,
        districtB: `team-district-b-${run}`,
        guestA1: `team-guest-a1-${run}`,
        guestA1Replay: `team-guest-a1-replay-${run}`,
        guestA2: `team-guest-a2-${run}`,
        guestB: `team-guest-b-${run}`,
        foreignStudio: `team-foreign-studio-${run}`,
        wrongEmail: `team-wrong-email-${run}`,
        unverified: `team-unverified-${run}`,
      };
      const [, managerA1] = await tx.insert(staffTable).values([
        { clerkUserId: users.districtA, organizationId: orgA.id, studioId: null, fullName: "District A", email: `district-a-${run}@example.com`, role: "district_manager" },
        { clerkUserId: users.managerA1, organizationId: orgA.id, studioId: studioA1.id, fullName: "Manager A1", email: `manager-a1-${run}@example.com`, role: "studio_manager" },
        { clerkUserId: users.managerA2, organizationId: orgA.id, studioId: studioA2.id, fullName: "Manager A2", email: `manager-a2-${run}@example.com`, role: "studio_manager" },
        { clerkUserId: users.employeeA1, organizationId: orgA.id, studioId: studioA1.id, fullName: "Employee A1", email: `employee-a1-${run}@example.com`, role: "studio_employee" },
        { clerkUserId: users.districtB, organizationId: orgB.id, studioId: null, fullName: "District B", email: `district-b-${run}@example.com`, role: "district_manager" },
      ]).returning();
      const emails = {
        a1: `invite-a1-${run}@example.com`,
        a2: `invite-a2-${run}@example.com`,
        b: `invite-b-${run}@example.com`,
        foreignStudio: `invite-foreign-studio-${run}@example.com`,
      };
      const identities = new Map([
        [users.guestA1, { fullName: "New A1", email: emails.a1, emailVerified: true }],
        [users.guestA1Replay, { fullName: "Replay A1", email: emails.a1, emailVerified: true }],
        [users.guestA2, { fullName: "New A2", email: emails.a2, emailVerified: true }],
        [users.guestB, { fullName: "New B", email: emails.b, emailVerified: true }],
        [users.foreignStudio, { fullName: "Wrong studio", email: emails.foreignStudio, emailVerified: true }],
        [users.wrongEmail, { fullName: "Wrong address", email: `wrong-${run}@example.com`, emailVerified: true }],
        [users.unverified, { fullName: "Unverified", email: emails.a1, emailVerified: false }],
      ]);

      const app = express();
      app.use(express.json());
      // This test instance substitutes identity and DB access; the default router uses Clerk and the live DB.
      app.use("/api", createTeamRouter({
        database: tx as unknown as typeof db,
        userIdFromRequest: (req) => req.get("x-test-user") ?? null,
        identityForUser: async (userId) => {
          const identity = identities.get(userId);
          if (!identity) throw new Error(`Unexpected test identity: ${userId}`);
          return { userId, ...identity };
        },
      }));
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      async function api<T = unknown>(
        user: string | null,
        method: "GET" | "POST",
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
      const draft = (studioId: number, role: string, email: string) => ({ studioId, role, email });
      async function invite(user: string, studioId: number, role: string, email: string) {
        const response = await api<Invitation>(user, "POST", "/team/invitations", draft(studioId, role, email));
        assert.equal(response.status, 201);
        assert.equal(response.body.studioId, studioId);
        assert.equal(response.body.role, role);
        return response.body;
      }
      async function list(user: string) {
        const response = await api<Invitation[]>(user, "GET", "/team/invitations");
        assert.equal(response.status, 200);
        return response.body;
      }
      const ids = (items: Invitation[]) => items.map((item) => item.id).sort((a, b) => a - b);

      try {
        await t.test("only a manager of the target studio or its district can invite", async () => {
          assert.equal((await api(null, "POST", "/team/invitations", draft(studioA1.id, "studio_employee", emails.a1))).status, 401);
          assert.equal((await api(users.employeeA1, "POST", "/team/invitations", draft(studioA1.id, "studio_employee", emails.a1))).status, 403);
          assert.equal((await api(users.managerA1, "POST", "/team/invitations", draft(studioA2.id, "studio_employee", emails.a1))).status, 403);
          assert.equal((await api(users.managerA1, "POST", "/team/invitations", draft(studioB.id, "studio_employee", emails.a1))).status, 403);
          assert.equal((await api(users.managerA2, "POST", "/team/invitations", draft(studioA1.id, "studio_employee", emails.a1))).status, 403);
          assert.equal((await api(users.districtA, "POST", "/team/invitations", draft(studioB.id, "studio_employee", emails.a1))).status, 403);
          assert.equal((await api(users.districtB, "POST", "/team/invitations", draft(studioA1.id, "studio_employee", emails.a1))).status, 403);
          assert.equal((await api(users.managerA1, "POST", "/team/invitations", draft(studioA1.id, "studio_manager", emails.a1))).status, 403);
          assert.equal((await api(users.managerA1, "POST", "/team/invitations", draft(studioA1.id, "district_manager", emails.a1))).status, 403);
          assert.deepEqual(await tx.select({ id: invitationsTable.id }).from(invitationsTable)
            .where(inArray(invitationsTable.organizationId, [orgA.id, orgB.id])), []);
        });

        const a1 = await invite(users.managerA1, studioA1.id, "studio_employee", emails.a1);
        const a2 = await invite(users.districtA, studioA2.id, "studio_manager", emails.a2);
        const b = await invite(users.districtB, studioB.id, "studio_employee", emails.b);
        const tokenA1 = a1.inviteUrl.split("/").at(-1);
        const tokenA2 = a2.inviteUrl.split("/").at(-1);
        const tokenB = b.inviteUrl.split("/").at(-1);
        assert.ok(tokenA1);
        assert.ok(tokenA2);
        assert.ok(tokenB);

        // Simulate a stale or incorrectly imported invitation: both foreign keys exist,
        // but the invitation's studio belongs to a different organization.
        const foreignToken = randomUUID();
        const [foreignStudioInvitation] = await tx.insert(invitationsTable).values({
          organizationId: orgA.id,
          studioId: studioB.id,
          invitedByStaffId: managerA1.id,
          email: emails.foreignStudio,
          role: "studio_employee",
          tokenHash: createHash("sha256").update(foreignToken).digest("hex"),
          expiresAt: new Date(Date.now() + 60_000),
        }).returning();

        await t.test("invitation lists and duplicates stay in the intended scope", async () => {
          assert.equal((await api(users.managerA1, "GET", "/team/invitations")).status, 200);
          assert.equal((await api(users.employeeA1, "GET", "/team/invitations")).status, 403);
          assert.equal((await api(null, "GET", "/team/invitations")).status, 401);
          assert.deepEqual(ids(await list(users.managerA1)), [a1.id]);
          assert.deepEqual(ids(await list(users.managerA2)), [a2.id]);
          assert.deepEqual(ids(await list(users.districtA)), [a1.id, a2.id].sort((x, y) => x - y));
          assert.deepEqual(ids(await list(users.districtB)), [b.id]);
          assert.ok(!(await list(users.districtA)).some((invitation) => invitation.id === foreignStudioInvitation.id));
          assert.ok(!(await list(users.districtB)).some((invitation) => invitation.id === foreignStudioInvitation.id));
          assert.ok((await list(users.districtA)).every((invitation) => invitation.inviteUrl === ""));
          assert.equal((await api(users.districtA, "POST", "/team/invitations", draft(studioA2.id, "studio_employee", emails.a1))).status, 409);
          const rows = await tx.select({
            id: invitationsTable.id,
            organizationId: invitationsTable.organizationId,
            studioId: invitationsTable.studioId,
          }).from(invitationsTable).where(inArray(invitationsTable.id, [a1.id, a2.id, b.id]));
          assert.deepEqual(rows.map(({ organizationId, studioId }) => [organizationId, studioId])
            .sort((left, right) => left[1] - right[1]),
            [[orgA.id, studioA1.id], [orgA.id, studioA2.id], [orgB.id, studioB.id]]);
        });

        await t.test("acceptance binds the verified email to the invitation's studio and role", async () => {
          const acceptA1 = `/team/invitations/${tokenA1}/accept`;
          const foreignAccept = await api(users.foreignStudio, "POST", `/team/invitations/${foreignToken}/accept`);
          assert.equal(foreignAccept.status, 404);
          const [foreignStillPending] = await tx.select({ status: invitationsTable.status })
            .from(invitationsTable).where(eq(invitationsTable.id, foreignStudioInvitation.id));
          assert.equal(foreignStillPending.status, "pending");
          assert.equal((await api(null, "POST", acceptA1)).status, 401);
          assert.equal((await api(users.unverified, "POST", acceptA1)).status, 403);
          assert.equal((await api(users.wrongEmail, "POST", acceptA1)).status, 403);
          const [pending] = await tx.select({ status: invitationsTable.status })
            .from(invitationsTable).where(eq(invitationsTable.id, a1.id));
          assert.equal(pending.status, "pending");

          const acceptedA1 = await api<{
            organizationId: number; studioId: number; role: string; email: string;
          }>(users.guestA1, "POST", acceptA1, {
            organizationId: orgB.id, studioId: studioB.id, role: "district_manager",
          });
          assert.equal(acceptedA1.status, 200);
          assert.equal(acceptedA1.body.organizationId, orgA.id);
          assert.equal(acceptedA1.body.studioId, studioA1.id);
          assert.equal(acceptedA1.body.role, "studio_employee");
          assert.equal(acceptedA1.body.email, emails.a1);
          assert.equal((await api(users.guestA1, "POST", acceptA1)).status, 409);
          assert.equal((await api(users.guestA1Replay, "POST", acceptA1)).status, 404);

          const acceptedA2 = await api<{ organizationId: number; studioId: number; role: string }>(
            users.guestA2, "POST", `/team/invitations/${tokenA2}/accept`);
          assert.equal(acceptedA2.status, 200);
          assert.equal(acceptedA2.body.organizationId, orgA.id);
          assert.equal(acceptedA2.body.studioId, studioA2.id);
          assert.equal(acceptedA2.body.role, "studio_manager");
          const acceptedB = await api<{ organizationId: number; studioId: number; role: string }>(
            users.guestB, "POST", `/team/invitations/${tokenB}/accept`);
          assert.equal(acceptedB.status, 200);
          assert.equal(acceptedB.body.organizationId, orgB.id);
          assert.equal(acceptedB.body.studioId, studioB.id);
          assert.equal(acceptedB.body.role, "studio_employee");

          const joined = await tx.select({
            clerkUserId: staffTable.clerkUserId,
            organizationId: staffTable.organizationId,
            studioId: staffTable.studioId,
            role: staffTable.role,
          }).from(staffTable).where(inArray(staffTable.clerkUserId, [
            users.guestA1, users.guestA1Replay, users.guestA2, users.guestB,
            users.wrongEmail, users.unverified, users.foreignStudio,
          ]));
          assert.deepEqual(joined, [
            { clerkUserId: users.guestA1, organizationId: orgA.id, studioId: studioA1.id, role: "studio_employee" },
            { clerkUserId: users.guestA2, organizationId: orgA.id, studioId: studioA2.id, role: "studio_manager" },
            { clerkUserId: users.guestB, organizationId: orgB.id, studioId: studioB.id, role: "studio_employee" },
          ]);
          assert.deepEqual(ids(await list(users.districtA)), [a1.id, a2.id].sort((x, y) => x - y));
          assert.ok((await list(users.districtA)).every((invitation) => invitation.status === "accepted"));
        });

      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve()));
      }
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
});

test("expired team invitations are listed but cannot grant access or block a replacement", async () => {
  try {
    await db.transaction(async (tx) => {
      const run = randomUUID();
      const managerId = `team-expiry-manager-${run}`;
      const guestId = `team-expiry-guest-${run}`;
      const email = `team-expiry-${run}@example.com`;
      const [organization] = await tx.insert(organizationsTable)
        .values({ name: `Team expiry test ${run}` }).returning();
      const [studio] = await tx.insert(studiosTable)
        .values({ organizationId: organization.id, name: "Expiry studio", city: "Berlin" }).returning();
      const [manager] = await tx.insert(staffTable).values({
        clerkUserId: managerId,
        organizationId: organization.id,
        studioId: studio.id,
        fullName: "Expiry manager",
        email: `team-expiry-manager-${run}@example.com`,
        role: "studio_manager",
      }).returning();
      const oldToken = randomUUID();
      const [expired] = await tx.insert(invitationsTable).values({
        organizationId: organization.id,
        studioId: studio.id,
        invitedByStaffId: manager.id,
        email,
        role: "studio_employee",
        tokenHash: createHash("sha256").update(oldToken).digest("hex"),
        expiresAt: new Date(Date.now() - 60_000),
      }).returning();

      const app = express();
      app.use(express.json());
      app.use("/api", createTeamRouter({
        database: tx as unknown as typeof db,
        userIdFromRequest: (req) => req.get("x-test-user") ?? null,
        identityForUser: async (userId) => {
          assert.equal(userId, guestId);
          return { userId, fullName: "Expired invitee", email, emailVerified: true };
        },
      }));
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      async function api<T>(user: string, method: "GET" | "POST", path: string, data?: unknown) {
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: {
            "x-test-user": user,
            ...(data === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        });
        return { status: response.status, body: await response.json() as T };
      }

      try {
        const listed = await api<Invitation[]>(managerId, "GET", "/team/invitations");
        assert.equal(listed.status, 200);
        assert.equal(listed.body.length, 1);
        assert.equal(listed.body[0].id, expired.id);
        assert.equal(listed.body[0].status, "expired");

        const oldPath = `/team/invitations/${oldToken}/accept`;
        assert.equal((await api(guestId, "POST", oldPath)).status, 404);
        assert.deepEqual(await tx.select({ id: staffTable.id }).from(staffTable)
          .where(eq(staffTable.clerkUserId, guestId)), []);
        const [unchanged] = await tx.select({ status: invitationsTable.status })
          .from(invitationsTable).where(eq(invitationsTable.id, expired.id));
        assert.equal(unchanged.status, "pending");

        const replacement = await api<Invitation>(managerId, "POST", "/team/invitations", {
          studioId: studio.id, role: "studio_employee", email,
        });
        assert.equal(replacement.status, 201);
        assert.notEqual(replacement.body.id, expired.id);
        assert.equal(replacement.body.email, email);
        assert.equal(replacement.body.status, "pending");
        assert.equal((await api(guestId, "POST", oldPath)).status, 404);
        const [stillPending] = await tx.select({ status: invitationsTable.status })
          .from(invitationsTable).where(eq(invitationsTable.id, expired.id));
        assert.equal(stillPending.status, "pending");
        assert.deepEqual(await tx.select({ id: staffTable.id }).from(staffTable)
          .where(eq(staffTable.clerkUserId, guestId)), []);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve()));
      }
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
});

test("parallel acceptance of one invitation grants only one team access", async () => {
  const run = randomUUID();
  const email = `team-parallel-${run}@example.com`;
  const token = randomUUID();
  const userA = `team-parallel-a-${run}`;
  const userB = `team-parallel-b-${run}`;
  let organizationId: number | undefined;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  let releaseA: (() => void) | undefined;
  let releaseB: (() => void) | undefined;

  try {
    const [organization] = await db.insert(organizationsTable)
      .values({ name: `Parallel invitation ${run}` }).returning();
    organizationId = organization.id;
    const [studio] = await db.insert(studiosTable)
      .values({ organizationId, name: "Parallel studio", city: "Berlin" }).returning();
    const [manager] = await db.insert(staffTable).values({
      clerkUserId: `team-parallel-manager-${run}`,
      organizationId, studioId: studio.id, fullName: "Manager",
      email: `team-parallel-manager-${run}@example.com`, role: "studio_manager",
    }).returning();
    const [invitation] = await db.insert(invitationsTable).values({
      organizationId, studioId: studio.id, invitedByStaffId: manager.id,
      email, role: "studio_employee",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    }).returning();

    // Pin each HTTP request to a different PostgreSQL session. Using the global
    // pool here would usually do the same, but explicit clients make this test
    // independent of pool scheduling and prove the race is not serialized by a
    // shared transaction/connection.
    const connectionA = await pool.connect();
    releaseA = () => connectionA.release();
    const connectionB = await pool.connect();
    releaseB = () => connectionB.release();
    const databaseA = drizzle(connectionA) as unknown as typeof db;
    const databaseB = drizzle(connectionB) as unknown as typeof db;

    // Hold both HTTP requests at identity lookup so neither can complete before
    // the other starts; each router is permanently bound to its own DB session.
    let arrivals = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>(resolve => { release = resolve; });
    const app = express();
    app.use(express.json());
    const dependencies = (database: typeof db) => ({
      database,
      userIdFromRequest: (req: express.Request) => req.get("x-test-user") ?? null,
      identityForUser: async (userId: string) => {
        if (userId !== userA && userId !== userB) throw new Error("Unexpected test identity");
        if (++arrivals === 2) release();
        await bothArrived;
        return { userId, fullName: userId, email, emailVerified: true };
      },
    });
    const routerA = createTeamRouter(dependencies(databaseA));
    const routerB = createTeamRouter(dependencies(databaseB));
    app.use("/api", (req, res, next) => {
      const router = req.get("x-test-user") === userA ? routerA
        : req.get("x-test-user") === userB ? routerB
          : null;
      if (!router) {
        next();
        return;
      }
      router(req, res, next);
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/team/invitations/${token}/accept`;
    const responses = await Promise.all([userA, userB].map(async userId => {
      const response = await fetch(url, { method: "POST", headers: { "x-test-user": userId } });
      return { status: response.status, body: await response.json() as { userId?: string } };
    }));

    assert.equal(responses.filter(response => response.status === 200).length, 1);
    assert.ok([404, 409].includes(responses.find(response => response.status !== 200)!.status));
    const winner = responses.find(response => response.status === 200)!.body.userId;
    assert.ok(winner === userA || winner === userB);
    const staff = await db.select({
      clerkUserId: staffTable.clerkUserId,
      organizationId: staffTable.organizationId,
      studioId: staffTable.studioId,
      role: staffTable.role,
    }).from(staffTable).where(eq(staffTable.email, email));
    assert.deepEqual(staff, [{
      clerkUserId: winner,
      organizationId,
      studioId: studio.id,
      role: "studio_employee",
    }]);
    const [used] = await db.select({ status: invitationsTable.status })
      .from(invitationsTable).where(eq(invitationsTable.id, invitation.id));
    assert.equal(used.status, "accepted");
    const loser = winner === userA ? userB : userA;
    const replay = await fetch(url, { method: "POST", headers: { "x-test-user": loser } });
    assert.equal(replay.status, 404);
    const winnerReplay = await fetch(url, { method: "POST", headers: { "x-test-user": winner } });
    assert.equal(winnerReplay.status, 409);
    assert.equal((await db.select({ id: staffTable.id }).from(staffTable)
      .where(eq(staffTable.email, email))).length, 1);
    const [stillAccepted] = await db.select({ status: invitationsTable.status })
      .from(invitationsTable).where(eq(invitationsTable.id, invitation.id));
    assert.equal(stillAccepted.status, "accepted");
  } finally {
    if (server?.listening) await new Promise<void>((resolve, reject) =>
      server!.close(error => error ? reject(error) : resolve()));
    releaseA?.();
    releaseB?.();
    if (organizationId !== undefined) {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    }
  }
});

test("the real API mount allows a verified new invitee through without bypassing team administration", async () => {
  try {
    await db.transaction(async tx => {
      const run = randomUUID();
      const guest = `mount-guest-${run}`;
      const email = `mount-${run}@example.com`;
      const token = randomUUID();
      const [org] = await tx.insert(organizationsTable).values({ name: `Invitation mount ${run}` }).returning();
      const [, target] = await tx.insert(studiosTable).values([
        { organizationId: org.id, name: "Not the destination", city: "Berlin" },
        { organizationId: org.id, name: "Invited destination", city: "Hamburg" },
      ]).returning();
      const [manager] = await tx.insert(staffTable).values({
        clerkUserId: `mount-manager-${run}`, organizationId: org.id, studioId: target.id,
        fullName: "Manager", email: `manager-${email}`, role: "studio_manager",
      }).returning();
      const [invitation] = await tx.insert(invitationsTable).values({
        organizationId: org.id, studioId: target.id, invitedByStaffId: manager.id,
        email, role: "studio_employee", tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      }).returning();
      const app = express();
      app.use(express.json());
      // The production module guard reads Clerk's signed-out auth object.
      // The invitation handler alone uses the injected fixture identity below.
      app.use(clerkMiddleware());
      app.use("/api", createApiRouter(createTeamRouter({
        database: tx as unknown as typeof db,
        userIdFromRequest: req => req.get("x-test-user") ?? null,
        identityForUser: async userId => ({
          userId, email, fullName: "New invitee",
          emailVerified: userId !== "unverified",
        }),
      })));
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>(resolve => server.once("listening", resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
      const acceptUrl = `${origin}/team/invitations/${token}/accept`;
      try {
        assert.equal((await fetch(acceptUrl, { method: "POST" })).status, 401);
        assert.equal((await fetch(acceptUrl, {
          method: "POST", headers: { "x-test-user": "unverified" },
        })).status, 403);
        const [pending] = await tx.select({ status: invitationsTable.status })
          .from(invitationsTable).where(eq(invitationsTable.id, invitation.id));
        assert.equal(pending.status, "pending");
        assert.deepEqual(await tx.select({ id: staffTable.id }).from(staffTable)
          .where(eq(staffTable.clerkUserId, guest)), []);

        // The narrow exception must not open listing, creation, or other verbs.
        for (const [path, method] of [
          ["/team/invitations", "GET"], ["/team/invitations", "POST"],
          [`/team/invitations/${token}/accept`, "GET"],
        ]) {
          assert.equal((await fetch(`${origin}${path}`, { method })).status, 401);
        }
        const accepted = await fetch(acceptUrl, { method: "POST", headers: { "x-test-user": guest } });
        assert.equal(accepted.status, 200);
        const body = await accepted.json() as { studioId: number; organizationId: number; role: string };
        assert.equal(body.studioId, target.id);
        assert.equal(body.organizationId, org.id);
        assert.equal(body.role, "studio_employee");
        const [staff] = await tx.select().from(staffTable).where(eq(staffTable.clerkUserId, guest));
        assert.equal(staff.studioId, target.id);
        assert.equal((await fetch(acceptUrl, { method: "POST", headers: { "x-test-user": guest } })).status, 409);
      } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
});