import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import {
  courseBookingsTable, coursesTable, db, memberNotificationsTable, membersTable,
  organizationsTable, pool, studiosTable, waitlistEmailDeliveriesTable,
} from "@workspace/db";
import { cancelCourseBooking } from "../src/lib/course-bookings";
import {
  processWaitlistEmailDeliveries,
  runWaitlistEmailSchedulerTick,
  waitlistEmailReadiness,
} from "../src/lib/waitlist-email-worker";

test("waitlist email readiness checks the sender domain through the authenticated Resend connection", async () => {
  let url = "";
  let method = "";
  const verified = await waitlistEmailReadiness(async (requestUrl, init) => {
    url = requestUrl;
    method = init.method ?? "";
    return new Response(JSON.stringify({ data: [{ name: "fiudia.com", status: "verified" }] }), { status: 200 });
  }, "mail@fiudia.com");
  assert.equal(url, "https://api.resend.com/domains");
  assert.equal(method, "GET");
  assert.equal(verified, null);

  const unverified = await waitlistEmailReadiness(async () =>
    new Response(JSON.stringify({ data: [{ name: "fiudia.com", status: "pending" }] }), { status: 200 }),
  "mail@fiudia.com");
  assert.match(unverified ?? "", /nicht verifiziert/);
});

test("promotion email outbox respects opt-in, retries idempotently, and skips invalidated promotions", async () => {
  const organizationIds: number[] = [];
  const suffix = randomUUID();
  let calls = 0;
  const idempotencyKeys: string[] = [];
  const requestBodies: Array<Record<string, unknown>> = [];
  const request = async (_url: string, init: RequestInit) => {
    calls += 1;
    idempotencyKeys.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
    assert.equal(new Headers(init.headers).get("Authorization"), null, "the Replit connector supplies provider authentication");
    requestBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    if (calls === 1) return new Response(JSON.stringify({ message: "temporary failure" }), { status: 503 });
    return new Response(JSON.stringify({ id: `resend-${calls}` }), { status: 200 });
  };

  async function promotedFixture(label: string, optedIn = true) {
    const [organization] = await db.insert(organizationsTable).values({ name: `${label} ${suffix}` }).returning();
    organizationIds.push(organization.id);
    const [studio] = await db.insert(studiosTable).values({
      organizationId: organization.id, name: "Teststudio", city: "Berlin",
    }).returning();
    const [confirmedMember, waitingMember] = await db.insert(membersTable).values([
      { studioId: studio.id, fullName: "Confirmed", email: `confirmed-${suffix}@example.invalid`, membershipType: "Basic" },
      {
        studioId: studio.id, fullName: "Waiting", email: `waiting-${label}-${suffix}@example.invalid`,
        membershipType: "Basic", waitlistEmailEnabled: optedIn ? 1 : 0,
      },
    ]).returning();
    const [course] = await db.insert(coursesTable).values({
      studioId: studio.id, title: `Course ${label}`, instructor: "Trainer",
      startsAt: new Date(Date.now() + 86400000), endsAt: new Date(Date.now() + 90000000),
      capacity: 1, enrolled: 1, status: "full", room: "A",
    }).returning();
    const [booking, waitingBooking] = await db.insert(courseBookingsTable).values([
      { courseId: course.id, memberId: confirmedMember.id, status: "confirmed" },
      { courseId: course.id, memberId: waitingMember.id, status: "waitlisted" },
    ]).returning();
    await cancelCourseBooking(course.id, confirmedMember.id);
    const [delivery] = await db.select().from(waitlistEmailDeliveriesTable)
      .where(eq(waitlistEmailDeliveriesTable.bookingId, waitingBooking.id));
    return { course, confirmedMember, waitingMember, booking, waitingBooking, delivery };
  }

  try {
    const eligible = await promotedFixture("eligible");
    assert.ok(eligible.delivery);
    assert.equal(eligible.delivery.status, "pending");
    assert.equal(eligible.delivery.email, eligible.waitingMember.email);

    const firstNow = new Date();
    assert.equal(await processWaitlistEmailDeliveries({ request, now: firstNow }), 1);
    let [retried] = await db.select().from(waitlistEmailDeliveriesTable)
      .where(eq(waitlistEmailDeliveriesTable.id, eligible.delivery.id));
    assert.equal(retried.status, "failed");
    assert.equal(retried.attemptCount, 1);
    assert.match(retried.error ?? "", /temporary failure/);
    const retryNow = new Date(retried.nextAttemptAt.getTime() + 1);
    assert.equal(await processWaitlistEmailDeliveries({ request, now: retryNow }), 1);
    [retried] = await db.select().from(waitlistEmailDeliveriesTable)
      .where(eq(waitlistEmailDeliveriesTable.id, eligible.delivery.id));
    assert.equal(retried.status, "sent");
    assert.equal(retried.attemptCount, 2);
    assert.equal(retried.providerId, "resend-2");
    assert.equal(idempotencyKeys[0], idempotencyKeys[1], "Resend idempotency key stays stable across retries");
    assert.deepEqual(requestBodies[0], requestBodies[1], "retry payload is the original snapshot");
    assert.deepEqual(requestBodies[1].to, [eligible.waitingMember.email]);
    assert.equal(requestBodies[1].subject, eligible.delivery.subject);
    assert.equal(requestBodies[1].text, eligible.delivery.text);

    const optedOut = await promotedFixture("opted-out", false);
    assert.equal(optedOut.delivery, undefined, "non-opted-in promotions do not enter the outbox");
    const legacyNotice = await db.insert(memberNotificationsTable).values({
      bookingId: optedOut.waitingBooking.id,
      memberId: optedOut.waitingMember.id,
      courseId: optedOut.course.id,
      title: "Legacy emailRequested notice",
      body: "Must not be sent",
      emailRequested: 1,
    }).returning();
    assert.ok(legacyNotice[0]);

    const preferenceChanged = await promotedFixture("preference-changed");
    assert.ok(preferenceChanged.delivery);
    const beforeReadinessCheck = calls;
    let readinessCalls = 0;
    assert.equal(await runWaitlistEmailSchedulerTick({
      readiness: () => waitlistEmailReadiness(
        async url => {
          assert.equal(url, "https://api.resend.com/domains");
          readinessCalls += 1;
          return new Response(JSON.stringify({ message: "API key is invalid" }), { status: 400 });
        },
        "mail@example.invalid",
      ),
      request,
    }), 0);
    assert.equal(readinessCalls, 1);
    assert.equal(calls, beforeReadinessCheck, "known-invalid provider credentials defer before claiming");
    const [stillPending] = await db.select().from(waitlistEmailDeliveriesTable)
      .where(eq(waitlistEmailDeliveriesTable.id, preferenceChanged.delivery.id));
    assert.equal(stillPending.status, "pending", "readiness failure does not consume retries");
    await db.update(membersTable).set({ waitlistEmailEnabled: 0 })
      .where(eq(membersTable.id, preferenceChanged.waitingMember.id));
    const beforeOptOutProcessing = calls;
    assert.equal(await processWaitlistEmailDeliveries({ request }), 1);
    assert.equal(calls, beforeOptOutProcessing, "current opt-out is rechecked before sending");
    const [optOutDelivery] = await db.select().from(waitlistEmailDeliveriesTable)
      .where(eq(waitlistEmailDeliveriesTable.id, preferenceChanged.delivery.id));
    assert.equal(optOutDelivery.status, "skipped");

    const changedAddress = await promotedFixture("changed-address");
    assert.ok(changedAddress.delivery);
    await db.update(membersTable).set({ email: `changed-${suffix}@example.invalid` })
      .where(eq(membersTable.id, changedAddress.waitingMember.id));
    const beforeChangedAddress = calls;
    assert.equal(await processWaitlistEmailDeliveries({ request }), 1);
    assert.equal(calls, beforeChangedAddress, "a changed email address is never sent to");
    const [addressDelivery] = await db.select().from(waitlistEmailDeliveriesTable)
      .where(eq(waitlistEmailDeliveriesTable.id, changedAddress.delivery.id));
    assert.equal(addressDelivery.status, "skipped");

    const missingProviderId = await promotedFixture("missing-provider-id");
    assert.ok(missingProviderId.delivery);
    const invalidSuccessRequest = async () => new Response(JSON.stringify({}), { status: 200 });
    assert.equal(await processWaitlistEmailDeliveries({
      request: invalidSuccessRequest,
    }), 1);
    const [invalidSuccessDelivery] = await db.select().from(waitlistEmailDeliveriesTable)
      .where(eq(waitlistEmailDeliveriesTable.id, missingProviderId.delivery.id));
    assert.equal(invalidSuccessDelivery.status, "failed");
    assert.equal(invalidSuccessDelivery.providerId, null);
    assert.match(invalidSuccessDelivery.error ?? "", /without a provider message ID/);

    const invalidated = await promotedFixture("cancelled");
    assert.ok(invalidated.delivery);
    await cancelCourseBooking(invalidated.course.id, invalidated.waitingMember.id);
    const [cancelledDelivery] = await db.select().from(waitlistEmailDeliveriesTable)
      .where(eq(waitlistEmailDeliveriesTable.id, invalidated.delivery.id));
    assert.equal(cancelledDelivery.status, "skipped");

    const beforeSkippedProcessing = calls;
    assert.equal(await processWaitlistEmailDeliveries({ request }), 0);
    assert.equal(calls, beforeSkippedProcessing, "legacy and invalidated notices never reach Resend");
  } finally {
    for (const organizationId of organizationIds) {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    }
    await pool.end();
  }
});