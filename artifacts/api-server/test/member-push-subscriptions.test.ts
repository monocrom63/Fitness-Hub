import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import express from "express";
import {
  db,
  memberPushSubscriptionsTable,
  membersTable,
  organizationModulesTable,
  organizationsTable,
  pool,
  studiosTable,
} from "@workspace/db";
import memberAppRouter from "../src/routes/member-app";

test("member push subscriptions are registered and removed only by their linked owner", async () => {
  const suffix = randomUUID();
  let organizationId: number | undefined;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;

  try {
    const [organization] = await db.insert(organizationsTable)
      .values({ name: `Push subscription test ${suffix}` }).returning();
    organizationId = organization.id;
    const [studio] = await db.insert(studiosTable).values({
      organizationId: organization.id,
      name: `Push test studio ${suffix}`,
      city: "Berlin",
    }).returning();
    const [owner, otherMember, inactiveMember] = await db.insert(membersTable).values([
      {
        studioId: studio.id,
        fullName: "Push Owner",
        email: `push-owner-${suffix}@example.invalid`,
        membershipType: "Basic",
        clerkUserId: `push-owner-${suffix}`,
      },
      {
        studioId: studio.id,
        fullName: "Push Other",
        email: `push-other-${suffix}@example.invalid`,
        membershipType: "Basic",
        clerkUserId: `push-other-${suffix}`,
      },
      {
        studioId: studio.id,
        fullName: "Push Inactive",
        email: `push-inactive-${suffix}@example.invalid`,
        membershipType: "Basic",
        status: "inactive",
        clerkUserId: `push-inactive-${suffix}`,
      },
    ]).returning();

    const app = express();
    app.use(express.json());
    // Supply a Clerk-shaped identity only on this local test server.
    app.use((req, _res, next) => {
      const userId = req.header("x-test-user") ?? null;
      const auth = Object.assign(() => ({ userId, tokenType: "session_token" }), {
        [Symbol.for("@clerk/express.auth")]: true,
      });
      Object.assign(req, { auth });
      next();
    });
    app.use("/api", memberAppRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

    async function request(
      user: string | null,
      method: "POST" | "DELETE",
      path: string,
      data?: unknown,
    ): Promise<{ status: number; body: unknown }> {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(user ? { "x-test-user": user } : {}),
          ...(data === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      return { status: response.status, body: await response.json() as unknown };
    }

    const subscriptionId = randomUUID();
    const moduleBlockedSubscriptionId = randomUUID();
    const rowsFor = (id: string) => db.select({
      subscriptionId: memberPushSubscriptionsTable.subscriptionId,
      memberId: memberPushSubscriptionsTable.memberId,
    }).from(memberPushSubscriptionsTable)
      .where(eq(memberPushSubscriptionsTable.subscriptionId, id));

    assert.equal((await request(null, "POST", "/member/push-subscriptions", { subscriptionId })).status, 401);
    assert.equal((await request(null, "DELETE", `/member/push-subscriptions/${subscriptionId}`)).status, 401);
    assert.equal((await request(`unlinked-${suffix}`, "POST", "/member/push-subscriptions", { subscriptionId })).status, 403);
    assert.equal((await request(`unlinked-${suffix}`, "DELETE", `/member/push-subscriptions/${subscriptionId}`)).status, 403);
    assert.equal((await request(inactiveMember.clerkUserId!, "POST", "/member/push-subscriptions", {
      subscriptionId,
    })).status, 403);
    assert.deepEqual(await rowsFor(subscriptionId), []);

    await db.insert(organizationModulesTable).values({
      organizationId: organization.id,
      key: "courses",
      enabled: 0,
    });
    assert.equal((await request(owner.clerkUserId!, "POST", "/member/push-subscriptions", {
      subscriptionId: moduleBlockedSubscriptionId,
    })).status, 403);
    assert.deepEqual(await rowsFor(moduleBlockedSubscriptionId), []);
    await db.update(organizationModulesTable).set({ enabled: 1 }).where(eq(
      organizationModulesTable.organizationId,
      organization.id,
    ));

    assert.equal((await request(owner.clerkUserId!, "POST", "/member/push-subscriptions", {
      subscriptionId: "not-a-uuid",
    })).status, 400);
    assert.equal((await request(owner.clerkUserId!, "DELETE", "/member/push-subscriptions/not-a-uuid")).status, 400);
    assert.deepEqual(await rowsFor("not-a-uuid"), []);

    const registered = await request(owner.clerkUserId!, "POST", "/member/push-subscriptions", { subscriptionId });
    assert.equal(registered.status, 200);
    assert.deepEqual(registered.body, { subscriptionId, registered: true });
    assert.deepEqual(await rowsFor(subscriptionId), [{ subscriptionId, memberId: owner.id }]);

    const duplicate = await request(owner.clerkUserId!, "POST", "/member/push-subscriptions", { subscriptionId });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(duplicate.body, { subscriptionId, registered: true });
    assert.deepEqual(await rowsFor(subscriptionId), [{ subscriptionId, memberId: owner.id }]);

    const claimByOther = await request(otherMember.clerkUserId!, "POST", "/member/push-subscriptions", {
      subscriptionId,
    });
    assert.equal(claimByOther.status, 409);
    assert.deepEqual(await rowsFor(subscriptionId), [{ subscriptionId, memberId: owner.id }]);

    const removeByOther = await request(
      otherMember.clerkUserId!,
      "DELETE",
      `/member/push-subscriptions/${subscriptionId}`,
    );
    assert.equal(removeByOther.status, 200);
    assert.deepEqual(removeByOther.body, { subscriptionId, registered: false });
    assert.deepEqual(await rowsFor(subscriptionId), [{ subscriptionId, memberId: owner.id }]);

    const removedByOwner = await request(
      owner.clerkUserId!,
      "DELETE",
      `/member/push-subscriptions/${subscriptionId}`,
    );
    assert.equal(removedByOwner.status, 200);
    assert.deepEqual(removedByOwner.body, { subscriptionId, registered: false });
    assert.deepEqual(await rowsFor(subscriptionId), []);

    const registeredByOther = await request(otherMember.clerkUserId!, "POST", "/member/push-subscriptions", {
      subscriptionId,
    });
    assert.equal(registeredByOther.status, 200);
    assert.deepEqual(registeredByOther.body, { subscriptionId, registered: true });
    assert.deepEqual(await rowsFor(subscriptionId), [{ subscriptionId, memberId: otherMember.id }]);
  } finally {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => error ? reject(error) : resolve()),
      );
    }
    if (organizationId !== undefined) {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    }
    await pool.end();
  }
});