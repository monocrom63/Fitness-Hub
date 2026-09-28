import { createHash, randomUUID } from "node:crypto";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { and, asc, eq, inArray, lte, lt, or, sql } from "drizzle-orm";
import {
  courseBookingsTable,
  courseEditPushDeliveriesTable,
  coursesTable,
  db,
  memberPushSubscriptionsTable,
  membersTable,
} from "@workspace/db";

const APP_ID = "c1a30beb-bc79-45f6-9cdd-275e663dbcd6";
const MAX_ATTEMPTS = 5;
const CLAIM_LEASE_MS = 5 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 20_000;
const connectors = new ReplitConnectors();

export type CourseEditPushProxy = (
  path: string,
  options?: { method?: string; body?: unknown; headers?: Record<string, string> },
) => Promise<Response>;

const oneSignalProxy: CourseEditPushProxy = (path, options) =>
  connectors.proxy("onesignal", path, options);

export function courseEditIdempotencyKey(
  courseId: number,
  revision: number,
  bookingId: number,
  subscriptionId: string,
): string {
  const bytes = createHash("sha256")
    .update(`${courseId}:${revision}:${bookingId}:${subscriptionId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type Claim = {
  id: number;
  courseId: number;
  courseRevision: number;
  bookingId: number;
  memberId: number;
  subscriptionId: string;
  title: string;
  body: string;
  idempotencyKey: string;
  claimToken: string;
};

async function claimOne(courseId?: number) {
  return db.transaction(async (tx) => {
    const now = new Date();
    const expiredBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
    const [row] = await tx.select({
      id: courseEditPushDeliveriesTable.id,
      courseId: courseEditPushDeliveriesTable.courseId,
      courseRevision: courseEditPushDeliveriesTable.courseRevision,
      bookingId: courseEditPushDeliveriesTable.bookingId,
      memberId: courseEditPushDeliveriesTable.memberId,
      subscriptionId: courseEditPushDeliveriesTable.subscriptionId,
      title: courseEditPushDeliveriesTable.title,
      body: courseEditPushDeliveriesTable.body,
      idempotencyKey: courseEditPushDeliveriesTable.idempotencyKey,
      status: courseEditPushDeliveriesTable.status,
      attemptCount: courseEditPushDeliveriesTable.attemptCount,
    }).from(courseEditPushDeliveriesTable).where(and(
      or(
        and(
          inArray(courseEditPushDeliveriesTable.status, ["pending", "failed"]),
          lte(courseEditPushDeliveriesTable.nextAttemptAt, now),
        ),
        and(
          eq(courseEditPushDeliveriesTable.status, "sending"),
          lt(courseEditPushDeliveriesTable.claimedAt, expiredBefore),
        ),
      ),
      courseId === undefined ? undefined : eq(courseEditPushDeliveriesTable.courseId, courseId),
      lt(courseEditPushDeliveriesTable.attemptCount, MAX_ATTEMPTS),
    )).orderBy(asc(courseEditPushDeliveriesTable.createdAt), asc(courseEditPushDeliveriesTable.id))
      .limit(1).for("update", { skipLocked: true });

    if (!row) {
      // Expired leases at the attempt limit are terminal, never left looking
      // like work that can be resumed forever.
      await tx.update(courseEditPushDeliveriesTable).set({
        status: "failed",
        error: "Push attempt limit reached.",
        claimToken: null,
        claimedAt: null,
      }).where(and(
        eq(courseEditPushDeliveriesTable.status, "sending"),
        lt(courseEditPushDeliveriesTable.claimedAt, expiredBefore),
        sql`${courseEditPushDeliveriesTable.attemptCount} >= ${MAX_ATTEMPTS}`,
      ));
      return null;
    }

    const claimToken = randomUUID();
    const [claimed] = await tx.update(courseEditPushDeliveriesTable).set({
      status: "sending",
      error: null,
      providerId: null,
      claimToken,
      claimedAt: now,
      attemptedAt: now,
      attemptCount: sql`${courseEditPushDeliveriesTable.attemptCount} + 1`,
    }).where(eq(courseEditPushDeliveriesTable.id, row.id)).returning({
      attemptCount: courseEditPushDeliveriesTable.attemptCount,
    });
    if (!claimed) return null;
    return { ...row, claimToken, attemptCount: claimed.attemptCount } as Claim & { attemptCount: number };
  });
}

function backoff(attempt: number) {
  return new Date(Date.now() + Math.min(6 * 60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempt - 1)));
}

async function settle(
  claim: Claim,
  result: { status: "sent" | "failed" | "skipped"; error: string | null; providerId?: string },
  attemptCount: number,
) {
  await db.update(courseEditPushDeliveriesTable).set({
    status: result.status,
    error: result.error,
    providerId: result.providerId ?? null,
    nextAttemptAt: result.status === "failed" && attemptCount < MAX_ATTEMPTS ? backoff(attemptCount) : new Date(),
    claimToken: null,
    claimedAt: null,
  }).where(and(
    eq(courseEditPushDeliveriesTable.id, claim.id),
    eq(courseEditPushDeliveriesTable.claimToken, claim.claimToken),
    eq(courseEditPushDeliveriesTable.status, "sending"),
  ));
}

async function sendClaim(
  claim: Claim,
  attemptCount: number,
  proxy: CourseEditPushProxy,
) {
  // A single statement revalidates claim ownership, consent, member, booking,
  // studio, course state and revision immediately before contacting OneSignal.
  // No database lock or transaction is held over provider I/O.
  const [eligible] = await db.select({
    deliveryId: courseEditPushDeliveriesTable.id,
  }).from(courseEditPushDeliveriesTable)
    .innerJoin(coursesTable, eq(coursesTable.id, courseEditPushDeliveriesTable.courseId))
    .innerJoin(courseBookingsTable, and(
      eq(courseBookingsTable.id, courseEditPushDeliveriesTable.bookingId),
      eq(courseBookingsTable.courseId, coursesTable.id),
    ))
    .innerJoin(membersTable, and(
      eq(membersTable.id, courseEditPushDeliveriesTable.memberId),
      eq(membersTable.id, courseBookingsTable.memberId),
    ))
    .innerJoin(memberPushSubscriptionsTable, and(
      eq(memberPushSubscriptionsTable.memberId, membersTable.id),
      eq(memberPushSubscriptionsTable.subscriptionId, courseEditPushDeliveriesTable.subscriptionId),
    ))
    .where(and(
      eq(courseEditPushDeliveriesTable.id, claim.id),
      eq(courseEditPushDeliveriesTable.status, "sending"),
      eq(courseEditPushDeliveriesTable.claimToken, claim.claimToken),
      eq(courseEditPushDeliveriesTable.courseId, claim.courseId),
      eq(courseEditPushDeliveriesTable.courseRevision, claim.courseRevision),
      eq(courseEditPushDeliveriesTable.bookingId, claim.bookingId),
      eq(courseEditPushDeliveriesTable.memberId, claim.memberId),
      eq(courseEditPushDeliveriesTable.subscriptionId, claim.subscriptionId),
      eq(courseEditPushDeliveriesTable.idempotencyKey, claim.idempotencyKey),
      eq(coursesTable.revision, claim.courseRevision),
      inArray(coursesTable.status, ["scheduled", "full"]),
      gtFutureCourse(),
      inArray(courseBookingsTable.status, ["confirmed", "waitlisted"]),
      eq(membersTable.status, "active"),
      eq(membersTable.studioId, coursesTable.studioId),
    )).limit(1);

  if (!eligible) {
    await settle(claim, {
      status: "skipped",
      error: "Subscription, membership, booking, or course edit is no longer eligible.",
    }, attemptCount);
    return;
  }

  // There is an unavoidable gap after the last DB recheck: once this request
  // starts, later edits or opt-outs cannot retract an accepted provider send.
  // The payload is intentionally generic so it cannot expose stale details.
  try {
    const { response, result } = await withTimeout((async () => {
      const response = await proxy("/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          app_id: APP_ID,
          include_subscription_ids: [claim.subscriptionId],
          target_channel: "push",
          headings: { en: claim.title },
          contents: { en: claim.body },
          data: { courseId: claim.courseId, memberId: claim.memberId },
          idempotency_key: claim.idempotencyKey,
        },
      });
      const result = await response.json().catch(() => ({})) as { id?: string; errors?: unknown };
      return { response, result };
    })(), PROVIDER_TIMEOUT_MS);
    const errorsPresent = result.errors &&
      (typeof result.errors !== "object" || Object.keys(result.errors).length > 0);
    if (!response.ok || errorsPresent || typeof result.id !== "string" || !result.id) {
      await settle(claim, {
        status: "failed",
        error: `OneSignal did not confirm this push (HTTP ${response.status}).`,
      }, attemptCount);
      return;
    }
    await settle(claim, { status: "sent", error: null, providerId: result.id }, attemptCount);
  } catch {
    await settle(claim, { status: "failed", error: "OneSignal push request failed or timed out." }, attemptCount);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Provider request timed out.")), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function gtFutureCourse() {
  return sql`${coursesTable.startsAt} > now()`;
}

export async function processCourseEditPushDeliveries(
  courseId?: number,
  proxy: CourseEditPushProxy = oneSignalProxy,
): Promise<void> {
  // A worker deliberately claims and handles no more than one row at a time.
  for (;;) {
    const claim = await claimOne(courseId);
    if (!claim) return;
    await sendClaim(claim, claim.attemptCount, proxy);
  }
}

let workerTimer: ReturnType<typeof setTimeout> | undefined;
let workerRunning = false;

export function startCourseEditPushWorker() {
  if (workerTimer) return;
  const tick = async () => {
    if (!workerRunning) {
      workerRunning = true;
      try {
        await processCourseEditPushDeliveries();
      } catch {
        // Delivery records remain durable for the next worker pass.
      } finally {
        workerRunning = false;
      }
    }
    workerTimer = setTimeout(tick, 15_000);
    workerTimer.unref?.();
  };
  void tick();
}