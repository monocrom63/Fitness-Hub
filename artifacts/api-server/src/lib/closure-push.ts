import { randomUUID } from "node:crypto";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { and, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import {
  closurePushDeliveriesTable,
  courseClosureResolutionsTable,
  coursesTable,
  db,
  memberPushSubscriptionsTable,
} from "@workspace/db";

const APP_ID = "c1a30beb-bc79-45f6-9cdd-275e663dbcd6";
const CLAIM_LEASE_MS = 5 * 60 * 1000;
const connectors = new ReplitConnectors();

export type OneSignalProxy = (
  path: string,
  options?: { method?: string; body?: unknown; headers?: Record<string, string> },
) => Promise<Response>;

type ClosurePushDeliveryTarget = {
  bookingId: number;
  memberId: number;
  subscriptionId: string | null;
  status: "pending" | "skipped";
  error: string | null;
};

export function buildClosurePushDeliveryTargets(
  bookings: readonly { id: number; memberId: number }[],
  subscriptions: readonly { memberId: number; subscriptionId: string }[],
): ClosurePushDeliveryTarget[] {
  const subscriptionsByMember = new Map<number, string[]>();
  for (const subscription of subscriptions) {
    const memberSubscriptions = subscriptionsByMember.get(subscription.memberId) ?? [];
    memberSubscriptions.push(subscription.subscriptionId);
    subscriptionsByMember.set(subscription.memberId, memberSubscriptions);
  }
  const targets: ClosurePushDeliveryTarget[] = [];
  for (const booking of bookings) {
    const memberSubscriptions = subscriptionsByMember.get(booking.memberId);
    if (!memberSubscriptions?.length) {
      targets.push({
        bookingId: booking.id,
        memberId: booking.memberId,
        subscriptionId: null,
        status: "skipped" as const,
        error: "Push nicht zugestellt: Für dieses Mitglied ist kein Browser-Push-Abonnement hinterlegt; der In-App-Fallback wurde erstellt.",
      });
      continue;
    }
    targets.push(...memberSubscriptions.map((subscriptionId) => ({
      bookingId: booking.id,
      memberId: booking.memberId,
      subscriptionId,
      status: "pending" as const,
      error: null,
    })));
  }
  return targets;
}

const oneSignalProxy: OneSignalProxy = (path, options) =>
  connectors.proxy("onesignal", path, options);

export async function closurePushReadiness(
  proxy: OneSignalProxy = oneSignalProxy,
): Promise<string | null> {
  try {
    const response = await proxy(
      `/notifications?app_id=${APP_ID}&limit=1&offset=0`,
      { method: "GET" },
    );
    if (response.status === 401) {
      return "Die OneSignal-Verbindung ist nicht autorisiert. Bitte verbinde OneSignal in Replit unter Tools → Integrationen und wähle anschließend In-App; der Kurs wurde nicht geändert.";
    }
    if (!response.ok) {
      return `OneSignal ist derzeit nicht versandbereit (HTTP ${response.status}). Bitte Verbindung prüfen oder In-App wählen; der Kurs wurde nicht geändert.`;
    }
    return null;
  } catch {
    return "OneSignal ist derzeit nicht erreichbar. Bitte Verbindung prüfen oder In-App wählen; der Kurs wurde nicht geändert.";
  }
}

type ClaimableDelivery = {
  id: number;
  memberId: number;
  subscriptionId: string;
  idempotencyKey: string;
  claimToken: string;
};

export async function claimResolutionPushDeliveries(resolutionId: number) {
  return db.transaction(async (tx) => {
    const now = new Date();
    const reclaimBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
    const claimable = await tx.select({
      id: closurePushDeliveriesTable.id,
      memberId: closurePushDeliveriesTable.memberId,
      subscriptionId: closurePushDeliveriesTable.subscriptionId,
      idempotencyKey: closurePushDeliveriesTable.idempotencyKey,
    }).from(closurePushDeliveriesTable).where(and(
      eq(closurePushDeliveriesTable.resolutionId, resolutionId),
      isNotNull(closurePushDeliveriesTable.subscriptionId),
      or(
        inArray(closurePushDeliveriesTable.status, ["pending", "failed"]),
        and(
          eq(closurePushDeliveriesTable.status, "sending"),
          lt(closurePushDeliveriesTable.claimedAt, reclaimBefore),
        ),
      ),
    )).for("update", { skipLocked: true });

    const claims: ClaimableDelivery[] = [];
    for (const delivery of claimable) {
      const claimToken = randomUUID();
      const [claimed] = await tx.update(closurePushDeliveriesTable).set({
        status: "sending",
        error: null,
        providerId: null,
        claimToken,
        claimedAt: now,
        attemptedAt: now,
        attemptCount: sql`${closurePushDeliveriesTable.attemptCount} + 1`,
      }).where(eq(closurePushDeliveriesTable.id, delivery.id)).returning({
        id: closurePushDeliveriesTable.id,
        memberId: closurePushDeliveriesTable.memberId,
        subscriptionId: closurePushDeliveriesTable.subscriptionId,
        idempotencyKey: closurePushDeliveriesTable.idempotencyKey,
      });
      if (claimed && claimed.subscriptionId !== null) {
        claims.push({
          id: claimed.id,
          memberId: claimed.memberId,
          subscriptionId: claimed.subscriptionId,
          idempotencyKey: claimed.idempotencyKey,
          claimToken,
        });
      }
    }
    return claims;
  });
}

async function sendOne(
  delivery: ClaimableDelivery,
  resolutionId: number,
  proxy: OneSignalProxy,
) {
  // A member can withdraw permission after a course change has queued this
  // delivery. Do not retry an old browser address after it has been unlinked.
  const [linkedSubscription] = await db.select({ id: memberPushSubscriptionsTable.subscriptionId })
    .from(memberPushSubscriptionsTable)
    .where(and(
      eq(memberPushSubscriptionsTable.subscriptionId, delivery.subscriptionId),
      eq(memberPushSubscriptionsTable.memberId, delivery.memberId),
    ))
    .limit(1);
  if (!linkedSubscription) {
    return {
      status: "skipped" as const,
      detail: "Push-Abo inzwischen abgemeldet; der In-App-Hinweis bleibt verfügbar.",
    };
  }
  const [resolution] = await db.select({
    action: courseClosureResolutionsTable.action,
    targetRoom: courseClosureResolutionsTable.targetRoom,
    courseId: courseClosureResolutionsTable.courseId,
  }).from(courseClosureResolutionsTable)
    .where(eq(courseClosureResolutionsTable.id, resolutionId))
    .limit(1);
  if (!resolution) return { status: "failed" as const, detail: "Course resolution no longer exists." };
  const [course] = await db.select({ title: coursesTable.title })
    .from(coursesTable).where(eq(coursesTable.id, resolution.courseId)).limit(1);
  if (!course) return { status: "failed" as const, detail: "Resolved course no longer exists." };

  const title = resolution.action === "cancel"
    ? "Dein Kurs wurde storniert"
    : "Der Kursraum wurde geändert";
  const body = resolution.action === "cancel"
    ? `Der Kurs „${course.title}“ wurde wegen einer Raumschließung abgesagt.`
    : `Der Kurs „${course.title}“ findet wegen einer Raumschließung nun in ${resolution.targetRoom} statt.`;
  try {
    const response = await proxy("/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {
        app_id: APP_ID,
        include_subscription_ids: [delivery.subscriptionId],
        target_channel: "push",
        headings: { en: title },
        contents: { en: body },
        idempotency_key: delivery.idempotencyKey,
      },
    });
    const result = await response.json().catch(() => ({})) as { id?: string; errors?: unknown; message?: string };
    if (!response.ok) {
      return {
        status: "failed" as const,
        detail: result.message ?? `OneSignal returned HTTP ${response.status}.`,
      };
    }
    if (result.errors && (typeof result.errors !== "object" || Object.keys(result.errors).length > 0)) {
      return {
        status: "failed" as const,
        detail: `OneSignal hat die Zieladresse abgelehnt: ${JSON.stringify(result.errors).slice(0, 300)}`,
      };
    }
    if (typeof result.id !== "string" || !result.id) {
      return {
        status: "failed" as const,
        detail: "OneSignal returned HTTP 200 without a notification ID (no confirmed audience).",
      };
    }
    return { status: "sent" as const, detail: null, providerId: result.id };
  } catch (error) {
    return {
      status: "failed" as const,
      detail: error instanceof Error ? error.message : "Push delivery failed.",
    };
  }
}

export async function processResolutionPushDeliveries(
  resolutionId: number,
  proxy: OneSignalProxy = oneSignalProxy,
) {
  const claims = await claimResolutionPushDeliveries(resolutionId);
  for (const claim of claims) {
    const outcome = await sendOne(claim, resolutionId, proxy);
    await db.update(closurePushDeliveriesTable).set({
      status: outcome.status,
      error: outcome.detail,
      providerId: "providerId" in outcome ? outcome.providerId : null,
      claimToken: null,
      claimedAt: null,
    }).where(and(
      eq(closurePushDeliveriesTable.id, claim.id),
      eq(closurePushDeliveriesTable.claimToken, claim.claimToken),
    ));
  }
  return getResolutionPushStatuses(resolutionId);
}

export async function getResolutionPushStatuses(resolutionId: number) {
  return db.select({
    id: closurePushDeliveriesTable.id,
    memberId: closurePushDeliveriesTable.memberId,
    status: closurePushDeliveriesTable.status,
    attemptCount: closurePushDeliveriesTable.attemptCount,
    error: closurePushDeliveriesTable.error,
    attemptedAt: closurePushDeliveriesTable.attemptedAt,
  }).from(closurePushDeliveriesTable)
    .where(eq(closurePushDeliveriesTable.resolutionId, resolutionId))
    .orderBy(closurePushDeliveriesTable.id);
}