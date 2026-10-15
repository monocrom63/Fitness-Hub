import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import express from "express";
import {
  db,
  memberInvitationsTable,
  membersTable,
  organizationsTable,
  pool,
  staffTable,
  studiosTable,
} from "@workspace/db";
import { createMemberInvitationsRouter } from "../src/routes/member-invitations";

after(async () => {
  await pool.end();
});

test("member onboarding invitations are scoped, verified, expiring and one-use", async () => {
  const run = randomUUID();
  const [orgA] = await db.insert(organizationsTable)
    .values({ name: `Member invitation test ${run}` }).returning();
  const [orgB] = await db.insert(organizationsTable)
    .values({ name: `Member invitation other ${run}` }).returning();
  const [studioA1, studioA2, studioB] = await db.insert(studiosTable).values([
    { organizationId: orgA.id, name: `Studio A1 ${run}`, city: "Berlin" },
    { organizationId: orgA.id, name: `Studio A2 ${run}`, city: "Berlin" },
    { organizationId: orgB.id, name: `Studio B ${run}`, city: "Hamburg" },
  ]).returning();
  const users = {
    managerA1: `member-manager-a1-${run}`,
    managerA2: `member-manager-a2-${run}`,
    managerB: `member-manager-b-${run}`,
    districtA: `member-district-a-${run}`,
    correct: `member-correct-${run}`,
    concurrent: `member-concurrent-${run}`,
    moved: `member-moved-${run}`,
    wrong: `member-wrong-${run}`,
    unverified: `member-unverified-${run}`,
    replay: `member-replay-${run}`,
  };
  const email = `member-${run}@example.com`;
  let failEmailDelivery = false;
  const sentEmails: Array<{ body: Record<string, unknown>; idempotencyKey: string | null }> = [];
  let server: import("node:http").Server | undefined;
  const memberIds: number[] = [];
  try {
    await db.insert(staffTable).values([
      { clerkUserId: users.managerA1, organizationId: orgA.id, studioId: studioA1.id, fullName: "Manager A1", email: `manager-a1-${run}@example.com`, role: "studio_manager" },
      { clerkUserId: users.managerA2, organizationId: orgA.id, studioId: studioA2.id, fullName: "Manager A2", email: `manager-a2-${run}@example.com`, role: "studio_manager" },
      { clerkUserId: users.managerB, organizationId: orgB.id, studioId: studioB.id, fullName: "Manager B", email: `manager-b-${run}@example.com`, role: "studio_manager" },
      { clerkUserId: users.districtA, organizationId: orgA.id, studioId: null, fullName: "District A", email: `district-a-${run}@example.com`, role: "district_manager" },
    ]);
    const [member] = await db.insert(membersTable).values({
      studioId: studioA1.id,
      fullName: "Invited member",
      email,
      membershipType: "Standard",
      status: "active",
    }).returning();
    memberIds.push(member.id);
    const [expiredMember] = await db.insert(membersTable).values({
      studioId: studioA1.id,
      fullName: "Expired member",
      email: `expired-${run}@example.com`,
      membershipType: "Standard",
      status: "active",
    }).returning();
    memberIds.push(expiredMember.id);
    const [movedMember] = await db.insert(membersTable).values({
      studioId: studioA1.id,
      fullName: "Moved member",
      email: `moved-${run}@example.com`,
      membershipType: "Standard",
      status: "active",
    }).returning();
    memberIds.push(movedMember.id);
    const [emailFailureMember] = await db.insert(membersTable).values({
      studioId: studioA1.id,
      fullName: "Email failure member",
      email: `email-failure-${run}@example.com`,
      membershipType: "Standard",
      status: "active",
    }).returning();
    memberIds.push(emailFailureMember.id);

    const identities = new Map([
      [users.correct, { userId: users.correct, fullName: "Correct user", email, emailVerified: true }],
      [users.concurrent, { userId: users.concurrent, fullName: "Concurrent user", email, emailVerified: true }],
      [users.moved, { userId: users.moved, fullName: "Moved user", email: `moved-${run}@example.com`, emailVerified: true }],
      [users.wrong, { userId: users.wrong, fullName: "Wrong user", email: `wrong-${run}@example.com`, emailVerified: true }],
      [users.unverified, { userId: users.unverified, fullName: "Unverified user", email, emailVerified: false }],
      [users.replay, { userId: users.replay, fullName: "Replay user", email, emailVerified: true }],
    ]);
    const app = express();
    app.use(express.json());
    app.use("/api", createMemberInvitationsRouter({
      userIdFromRequest: (req) => req.get("x-test-user") ?? null,
      identityForUser: async (userId) => {
        const identity = identities.get(userId);
        if (!identity) throw new Error("Unexpected test identity.");
        return identity;
      },
      emailSender: "Fiudia <mail@fiudia.test>",
      emailRequest: async (url, init) => {
        if (url.endsWith("/domains")) {
          return new Response(JSON.stringify({ data: [{ name: "fiudia.test", status: "verified" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        sentEmails.push({
          body,
          idempotencyKey: new Headers(init.headers).get("Idempotency-Key"),
        });
        if (failEmailDelivery) {
          return new Response(JSON.stringify({ message: "Temporary test provider failure." }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ id: `resend-${sentEmails.length}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }));
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const appOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const origin = `${appOrigin}/api`;

    async function api(user: string | null, path: string, data?: unknown) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          ...(user ? { "x-test-user": user } : {}),
          origin: appOrigin,
          ...(data === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    }

    assert.equal((await api(users.managerA2, `/members/${member.id}/invite`)).status, 403);
    assert.equal((await api(users.managerB, `/members/${member.id}/invite`)).status, 403);

    const created = await api(users.managerA1, `/members/${member.id}/invite`);
    assert.equal(created.status, 201);
    assert.equal(created.body.memberName, "Invited member");
    assert.equal(created.body.memberEmail, email);
    assert.equal(created.body.emailSent, true);
    const inviteUrl = created.body.inviteUrl as string;
    assert.match(inviteUrl, /^\/fiudia-members\/invite\/[a-f0-9]{64}$/);
    const sentInvitation = sentEmails[0];
    assert.deepEqual(sentInvitation.body.to, [email]);
    assert.equal(sentInvitation.body.subject, "Fiudia | Einladung von deinem Studio");
    assert.match(String(sentInvitation.body.text), new RegExp(`${appOrigin}/fiudia-members/invite/[a-f0-9]{64}`));
    assert.match(sentInvitation.idempotencyKey ?? "", /^fiudia-member-invitation-\d+-attempt-1$/);
    const oldToken = inviteUrl.split("/").at(-1)!;
    let token = oldToken;
    const [stored] = await db.select().from(memberInvitationsTable)
      .where(eq(memberInvitationsTable.memberId, member.id));
    let activeInvitationId = stored.id;
    assert.equal(stored.tokenHash.length, 64);
    assert.notEqual(stored.tokenHash, oldToken);
    assert.equal(stored.status, "pending");
    assert.equal(stored.studioId, studioA1.id);
    assert.equal(stored.email, email.toLowerCase());

    const wrongEmail = await api(users.wrong, "/member/invitations/accept", { token: oldToken });
    assert.equal(wrongEmail.status, 403);
    const unverified = await api(users.unverified, "/member/invitations/accept", { token: oldToken });
    assert.equal(unverified.status, 403);
    const [unlinked] = await db.select({ clerkUserId: membersTable.clerkUserId })
      .from(membersTable).where(eq(membersTable.id, member.id));
    assert.equal(unlinked.clerkUserId, null, "wrong or unverified email must never link the membership");
    const [stillPending] = await db.select({ status: memberInvitationsTable.status })
      .from(memberInvitationsTable).where(eq(memberInvitationsTable.id, stored.id));
    assert.equal(stillPending.status, "pending");

    const replacement = await api(users.districtA, `/members/${member.id}/invite`);
    assert.equal(replacement.status, 201);
    token = (replacement.body.inviteUrl as string).split("/").at(-1)!;
    assert.notEqual(token, oldToken);
    const [revoked] = await db.select({ status: memberInvitationsTable.status })
      .from(memberInvitationsTable).where(eq(memberInvitationsTable.id, stored.id));
    assert.equal(revoked.status, "revoked");
    assert.equal((await api(users.correct, "/member/invitations/accept", { token: oldToken })).status, 409);
    const [replacementStored] = await db.select({ id: memberInvitationsTable.id })
      .from(memberInvitationsTable).where(and(
        eq(memberInvitationsTable.memberId, member.id),
        eq(memberInvitationsTable.status, "pending"),
      ));
    activeInvitationId = replacementStored.id;

    const expiredLink = await api(users.districtA, `/members/${expiredMember.id}/invite`);
    assert.equal(expiredLink.status, 201);
    const expiredToken = (expiredLink.body.inviteUrl as string).split("/").at(-1)!;
    await db.update(memberInvitationsTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(memberInvitationsTable.memberId, expiredMember.id));
    assert.equal((await api(users.correct, "/member/invitations/accept", { token: expiredToken })).status, 404);

    failEmailDelivery = true;
    const firstRetryEmailIndex = sentEmails.length;
    const emailFailure = await api(users.managerA1, `/members/${emailFailureMember.id}/invite`);
    assert.equal(emailFailure.status, 201);
    assert.equal(emailFailure.body.emailSent, false);
    assert.match(emailFailure.body.inviteUrl as string, /^\/fiudia-members\/invite\/[a-f0-9]{64}$/);
    failEmailDelivery = false;
    const retry = await api(users.managerA1, `/members/${emailFailureMember.id}/invite/resend`);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.emailSent, true);
    assert.equal(retry.body.inviteUrl, emailFailure.body.inviteUrl, "retry preserves the original bearer link");
    assert.notEqual(sentEmails[firstRetryEmailIndex].idempotencyKey, sentEmails[firstRetryEmailIndex + 1].idempotencyKey);
    const [retryStored] = await db.select().from(memberInvitationsTable)
      .where(eq(memberInvitationsTable.memberId, emailFailureMember.id));
    assert.equal(retryStored.emailStatus, "sent");
    assert.equal(retryStored.emailAttemptCount, 2);

    const movedLink = await api(users.districtA, `/members/${movedMember.id}/invite`);
    assert.equal(movedLink.status, 201);
    const movedToken = (movedLink.body.inviteUrl as string).split("/").at(-1)!;
    await db.update(membersTable).set({ studioId: studioA2.id })
      .where(eq(membersTable.id, movedMember.id));
    assert.equal((await api(users.moved, "/member/invitations/accept", { token: movedToken })).status, 409);
    const [stillUnlinked] = await db.select({ clerkUserId: membersTable.clerkUserId })
      .from(membersTable).where(eq(membersTable.id, movedMember.id));
    assert.equal(stillUnlinked.clerkUserId, null);

    const [first, second] = await Promise.all([
      api(users.correct, "/member/invitations/accept", { token }),
      api(users.concurrent, "/member/invitations/accept", { token }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    const linkedResult = first.status === 200 ? first : second;
    assert.equal((linkedResult.body.member as { id: number }).id, member.id);
    assert.equal((await api(users.replay, "/member/invitations/accept", { token })).status, 409);

    const [claimed] = await db.select({ clerkUserId: membersTable.clerkUserId })
      .from(membersTable).where(eq(membersTable.id, member.id));
    assert.ok(claimed.clerkUserId === users.correct || claimed.clerkUserId === users.concurrent);
    const [consumed] = await db.select({ status: memberInvitationsTable.status })
      .from(memberInvitationsTable).where(eq(memberInvitationsTable.id, activeInvitationId));
    assert.equal(consumed.status, "accepted");
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => error ? reject(error) : resolve()));
    }
    if (memberIds.length) {
      await db.delete(memberInvitationsTable)
        .where(inArray(memberInvitationsTable.memberId, memberIds));
      await db.delete(membersTable).where(inArray(membersTable.id, memberIds));
    }
    await db.delete(staffTable).where(inArray(staffTable.clerkUserId, Object.values(users)));
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgA.id, orgB.id]));
  }
});