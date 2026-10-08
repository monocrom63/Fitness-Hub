import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import {
  courseBookingsTable, coursesTable, db, memberNotificationsTable, membersTable,
  waitlistEmailDeliveriesTable,
} from "@workspace/db";
import { closureEmailSender } from "./closure-email";
import { resendRequest, type ResendRequest } from "./resend-client";

const CLAIM_LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const READINESS_CACHE_MS = 5 * 60 * 1000;
const PROMOTION_TITLE = "Dein Kursplatz ist bestätigt";
export async function waitlistEmailReadiness(
  request: ResendRequest = resendRequest,
  sender = closureEmailSender(),
): Promise<string | null> {
  const domain = sender.match(/@([a-z0-9.-]+)>?$/i)?.[1]?.toLowerCase();
  if (!domain) return "Die E-Mail-Absenderadresse ist ungültig. Bitte In-App wählen.";
  try {
    const response = await request("https://api.resend.com/domains", {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    // A sending-only key may not have permission to list domains. The send
    // itself will still record its outcome durably.
    if (response.status === 403) return null;
    if (!response.ok) return "E-Mail ist derzeit nicht versandbereit. Bitte In-App wählen; der Kurs wurde nicht geändert.";
    const result = await response.json() as { data?: Array<{ name: string; status: string }> };
    if (!Array.isArray(result.data)) return "Die E-Mail-Absenderdomain konnte nicht geprüft werden. Bitte In-App wählen.";
    if (!result.data.some(entry => entry.name.toLowerCase() === domain && entry.status === "verified")) {
      return "Die E-Mail-Absenderdomain ist noch nicht verifiziert. Bitte In-App wählen.";
    }
    return null;
  } catch {
    return "Der E-Mail-Anbieter ist derzeit nicht erreichbar. Bitte In-App wählen; der Kurs wurde nicht geändert.";
  }
}

type ClaimedDelivery = {
  id: number;
  notificationId: number;
  bookingId: number;
  memberId: number;
  email: string;
  subject: string;
  text: string;
  claimToken: string;
  attemptCount: number;
};

type WorkerOptions = {
  database?: typeof db;
  request?: ResendRequest;
  sender?: string;
  now?: Date;
};

export async function claimWaitlistEmailDeliveries(
  database: typeof db = db,
  now = new Date(),
): Promise<ClaimedDelivery[]> {
  return database.transaction(async (tx) => {
    const reclaimBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
    await tx.update(waitlistEmailDeliveriesTable).set({
      status: "failed",
      error: "Delivery claim expired after the retry limit was reached.",
      claimToken: null,
      claimedAt: null,
      nextAttemptAt: now,
    }).where(and(
      eq(waitlistEmailDeliveriesTable.status, "sending"),
      lte(waitlistEmailDeliveriesTable.claimedAt, reclaimBefore),
      inArray(waitlistEmailDeliveriesTable.attemptCount, [MAX_ATTEMPTS]),
    ));
    const available = await tx.select({
      id: waitlistEmailDeliveriesTable.id,
      notificationId: waitlistEmailDeliveriesTable.notificationId,
      bookingId: waitlistEmailDeliveriesTable.bookingId,
      memberId: waitlistEmailDeliveriesTable.memberId,
      email: waitlistEmailDeliveriesTable.email,
      subject: waitlistEmailDeliveriesTable.subject,
      text: waitlistEmailDeliveriesTable.text,
      attemptCount: waitlistEmailDeliveriesTable.attemptCount,
    }).from(waitlistEmailDeliveriesTable).where(or(
      eq(waitlistEmailDeliveriesTable.status, "pending"),
      and(
        eq(waitlistEmailDeliveriesTable.status, "failed"),
        lte(waitlistEmailDeliveriesTable.nextAttemptAt, now),
        lt(waitlistEmailDeliveriesTable.attemptCount, MAX_ATTEMPTS),
      ),
      and(
        eq(waitlistEmailDeliveriesTable.status, "sending"),
        lt(waitlistEmailDeliveriesTable.claimedAt, reclaimBefore),
        lt(waitlistEmailDeliveriesTable.attemptCount, MAX_ATTEMPTS),
      ),
    )).limit(1).for("update", { skipLocked: true });

    const claims: ClaimedDelivery[] = [];
    for (const delivery of available) {
      const claimToken = randomUUID();
      const [claimed] = await tx.update(waitlistEmailDeliveriesTable).set({
        status: "sending",
        error: null,
        providerId: null,
        claimToken,
        claimedAt: now,
        attemptedAt: now,
        attemptCount: sql`${waitlistEmailDeliveriesTable.attemptCount} + 1`,
      }).where(eq(waitlistEmailDeliveriesTable.id, delivery.id)).returning({
        attemptCount: waitlistEmailDeliveriesTable.attemptCount,
      });
      if (claimed) claims.push({ ...delivery, attemptCount: claimed.attemptCount, claimToken });
    }
    return claims;
  });
}

type Preflight = {
  title: string;
  startsAt: Date;
  courseStatus: string;
  bookingStatus: string;
  memberStatus: string;
  emailEnabled: number;
  currentEmail: string;
  emailRequested: number;
  memberStudioId: number;
  courseStudioId: number;
};

async function loadPreflight(delivery: ClaimedDelivery, database: typeof db): Promise<Preflight | null> {
  const [record] = await database.select({
    title: memberNotificationsTable.title,
    emailRequested: memberNotificationsTable.emailRequested,
    startsAt: coursesTable.startsAt,
    courseStatus: coursesTable.status,
    bookingStatus: courseBookingsTable.status,
    memberStatus: membersTable.status,
    emailEnabled: membersTable.waitlistEmailEnabled,
    currentEmail: membersTable.email,
    memberStudioId: membersTable.studioId,
    courseStudioId: coursesTable.studioId,
  }).from(waitlistEmailDeliveriesTable)
    .innerJoin(memberNotificationsTable, eq(waitlistEmailDeliveriesTable.notificationId, memberNotificationsTable.id))
    .innerJoin(courseBookingsTable, eq(waitlistEmailDeliveriesTable.bookingId, courseBookingsTable.id))
    .innerJoin(coursesTable, eq(courseBookingsTable.courseId, coursesTable.id))
    .innerJoin(membersTable, eq(courseBookingsTable.memberId, membersTable.id))
    .where(and(
      eq(waitlistEmailDeliveriesTable.id, delivery.id),
      eq(waitlistEmailDeliveriesTable.status, "sending"),
      eq(waitlistEmailDeliveriesTable.claimToken, delivery.claimToken),
      eq(memberNotificationsTable.id, delivery.notificationId),
      eq(courseBookingsTable.id, delivery.bookingId),
      eq(membersTable.id, delivery.memberId),
      eq(memberNotificationsTable.bookingId, courseBookingsTable.id),
      eq(memberNotificationsTable.courseId, coursesTable.id),
      eq(memberNotificationsTable.memberId, membersTable.id),
    )).limit(1);
  return record ?? null;
}

async function finishClaim(
  delivery: ClaimedDelivery,
  values: {
    status: "sent" | "failed" | "skipped";
    error: string | null;
    providerId?: string | null;
    nextAttemptAt?: Date;
  },
  database: typeof db,
) {
  await database.update(waitlistEmailDeliveriesTable).set({
    status: values.status,
    error: values.error,
    providerId: values.providerId ?? null,
    nextAttemptAt: values.nextAttemptAt ?? new Date(),
    claimToken: null,
    claimedAt: null,
  }).where(and(
    eq(waitlistEmailDeliveriesTable.id, delivery.id),
    eq(waitlistEmailDeliveriesTable.claimToken, delivery.claimToken),
    eq(waitlistEmailDeliveriesTable.status, "sending"),
  ));
}

function retryAt(attemptCount: number, now: Date) {
  const delay = Math.min(60_000 * (2 ** Math.max(0, attemptCount - 1)), MAX_BACKOFF_MS);
  return new Date(now.getTime() + delay);
}

async function deliverOne(delivery: ClaimedDelivery, options: Required<WorkerOptions>) {
  const { database, request, sender, now } = options;
  const current = await loadPreflight(delivery, database);
  const valid = current
    && current.title === PROMOTION_TITLE
    && current.bookingStatus === "confirmed"
    && ["scheduled", "full"].includes(current.courseStatus)
    && current.startsAt > now
    && current.memberStatus === "active"
    && current.emailEnabled === 1
    && current.currentEmail.trim().length > 0
    && current.currentEmail.trim() === delivery.email
    && current.emailRequested === 1
    && current.memberStudioId === current.courseStudioId;
  if (!valid) {
    await finishClaim(delivery, {
      status: "skipped",
      error: "Promotion is no longer eligible for email delivery.",
    }, database);
    return;
  }

  try {
    const response = await request("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `fiudia-waitlist-delivery-${delivery.id}`,
      },
      body: JSON.stringify({ from: sender, to: [delivery.email], subject: delivery.subject, text: delivery.text }),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json().catch(() => ({})) as { id?: string; message?: string };
    const providerId = result.id?.trim();
    if (!response.ok || !providerId) {
      await finishClaim(delivery, {
        status: "failed",
        error: !response.ok
          ? result.message ?? `Resend returned HTTP ${response.status}.`
          : "Resend returned success without a provider message ID.",
        nextAttemptAt: retryAt(delivery.attemptCount, now),
      }, database);
      return;
    }
    await finishClaim(delivery, { status: "sent", error: null, providerId }, database);
  } catch (error) {
    await finishClaim(delivery, {
      status: "failed",
      error: error instanceof Error ? error.message : "Email delivery failed.",
      nextAttemptAt: retryAt(delivery.attemptCount, now),
    }, database);
  }
}

export async function processWaitlistEmailDeliveries(options: WorkerOptions = {}) {
  const workerOptions: Required<WorkerOptions> = {
    database: options.database ?? db,
    request: options.request ?? resendRequest,
    sender: options.sender ?? closureEmailSender(),
    now: options.now ?? new Date(),
  };
  const claims = await claimWaitlistEmailDeliveries(workerOptions.database, workerOptions.now);
  for (const claim of claims) await deliverOne(claim, workerOptions);
  return claims.length;
}

type SchedulerOptions = WorkerOptions & {
  readiness?: () => Promise<string | null>;
};

let readinessCache: { checkedAt: number; error: string | null } | undefined;
let lastReadinessWarningAt = Number.NEGATIVE_INFINITY;

export async function runWaitlistEmailSchedulerTick(options: SchedulerOptions = {}) {
  const now = options.now ?? new Date();
  let readinessError: string | null;
  if (options.readiness) {
    readinessError = await options.readiness();
  } else {
    if (!readinessCache || now.getTime() - readinessCache.checkedAt >= READINESS_CACHE_MS) {
      readinessCache = {
        checkedAt: now.getTime(),
        error: await waitlistEmailReadiness(
          options.request ?? resendRequest,
          options.sender ?? closureEmailSender(),
        ),
      };
    }
    readinessError = readinessCache.error;
  }
  if (readinessError) {
    if (!options.readiness && now.getTime() - lastReadinessWarningAt >= READINESS_CACHE_MS) {
      const { logger } = await import("./logger");
      logger.warn({ reason: "resend_not_ready" }, "Waitlist email processing deferred");
      lastReadinessWarningAt = now.getTime();
    }
    return 0;
  }
  return processWaitlistEmailDeliveries({ ...options, now });
}

let workerTimer: ReturnType<typeof setInterval> | undefined;

export function startWaitlistEmailWorker() {
  if (workerTimer) return;
  const loggerPromise = import("./logger");
  const process = () => {
    void runWaitlistEmailSchedulerTick().catch(async (error: unknown) => {
      const { logger } = await loggerPromise;
      logger.error({ err: error }, "Waitlist promotion email worker failed");
    });
  };
  process();
  workerTimer = setInterval(process, 30_000);
  workerTimer.unref();
}