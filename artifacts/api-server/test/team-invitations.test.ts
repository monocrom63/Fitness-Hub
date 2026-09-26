import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import express from "express";
import {
  db,
  invitationsTable,
  organizationsTable,
  pool,
  staffTable,
  studiosTable,
} from "@workspace/db";
import { createTeamRouter } from "../src/routes/team";

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
        wrongEmail: `team-wrong-email-${run}`,
        unverified: `team-unverified-${run}`,
      };
      await tx.insert(staffTable).values([
        { clerkUserId: users.districtA, organizationId: orgA.id, studioId: null, fullName: "District A", email: `district-a-${run}@example.com`, role: "district_manager" },
        { clerkUserId: users.managerA1, organizationId: orgA.id, studioId: studioA1.id, fullName: "Manager A1", email: `manager-a1-${run}@example.com`, role: "studio_manager" },
        { clerkUserId: users.managerA2, organizationId: orgA.id, studioId: studioA2.id, fullName: "Manager A2", email: `manager-a2-${run}@example.com`, role: "studio_manager" },
        { clerkUserId: users.employeeA1, organizationId: orgA.id, studioId: studioA1.id, fullName: "Employee A1", email: `employee-a1-${run}@example.com`, role: "studio_employee" },
        { clerkUserId: users.districtB, organizationId: orgB.id, studioId: null, fullName: "District B", email: `district-b-${run}@example.com`, role: "district_manager" },
      ]);
      const emails = {
        a1: `invite-a1-${run}@example.com`,
        a2: `invite-a2-${run}@example.com`,
        b: `invite-b-${run}@example.com`,
      };
      const identities = new Map([
        [users.guestA1, { fullName: "New A1", email: emails.a1, emailVerified: true }],
        [users.guestA1Replay, { fullName: "Replay A1", email: emails.a1, emailVerified: true }],
        [users.guestA2, { fullName: "New A2", email: emails.a2, emailVerified: true }],
        [users.guestB, { fullName: "New B", email: emails.b, emailVerified: true }],
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

        await t.test("invitation lists and duplicates stay in the intended scope", async () => {
          assert.equal((await api(users.managerA1, "GET", "/team/invitations")).status, 200);
          assert.equal((await api(users.employeeA1, "GET", "/team/invitations")).status, 403);
          assert.equal((await api(null, "GET", "/team/invitations")).status, 401);
          assert.deepEqual(ids(await list(users.managerA1)), [a1.id]);
          assert.deepEqual(ids(await list(users.managerA2)), [a2.id]);
          assert.deepEqual(ids(await list(users.districtA)), [a1.id, a2.id].sort((x, y) => x - y));
          assert.deepEqual(ids(await list(users.districtB)), [b.id]);
          assert.ok((await list(users.districtA)).every((invitation) => invitation.inviteUrl === ""));
          assert.equal((await api(users.districtA, "POST", "/team/invitations", draft(studioA2.id, "studio_employee", emails.a1))).status, 409);
          const rows = await tx.select({
            id: invitationsTable.id,
            organizationId: invitationsTable.organizationId,
            studioId: invitationsTable.studioId,
          }).from(invitationsTable).where(inArray(invitationsTable.id, [a1.id, a2.id, b.id]));
          assert.deepEqual(rows.map(({ organizationId, studioId }) => [organizationId, studioId]),
            [[orgA.id, studioA1.id], [orgA.id, studioA2.id], [orgB.id, studioB.id]]);
        });

        await t.test("acceptance binds the verified email to the invitation's studio and role", async () => {
          const acceptA1 = `/team/invitations/${tokenA1}/accept`;
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
            users.wrongEmail, users.unverified,
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