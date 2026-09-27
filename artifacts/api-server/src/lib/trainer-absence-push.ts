import { randomUUID } from "node:crypto";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  coursesTable, db, memberPushSubscriptionsTable, trainerAbsenceCoursesTable,
  trainerAbsencePushDeliveriesTable,
} from "@workspace/db";

const APP_ID = "c1a30beb-bc79-45f6-9cdd-275e663dbcd6";
const CLAIM_LEASE_MS = 5 * 60 * 1000;
const connectors = new ReplitConnectors();

export type TrainerPushProxy = (
  path: string,
  options?: { method?: string; body?: unknown; headers?: Record<string, string> },
) => Promise<Response>;

const oneSignalProxy: TrainerPushProxy = (path, options) => connectors.proxy("onesignal", path, options);

export function trainerDecisionNotice(
  title: string, status: string, instructor: string,
): { title: string; body: string } {
  if (status === "cancelled") {
    return {
      title: "Dein Kurs wurde abgesagt",
      body: `Der Kurs „${title}“ wurde abgesagt. Deine Buchung ist storniert.`,
    };
  }
  return {
    title: "Dein Kurs hat eine neue Trainerin oder einen neuen Trainer",
    body: `Der Kurs „${title}“ findet mit ${instructor} statt. Dein Platz bleibt bestehen.`,
  };
}

export async function processTrainerAbsencePush(
  absenceCourseId: number,
  proxy: TrainerPushProxy = oneSignalProxy,
) {
  const claims = await db.transaction(async (tx) => {
    const now = new Date();
    const rows = await tx.select({
      id: trainerAbsencePushDeliveriesTable.id,
      memberId: trainerAbsencePushDeliveriesTable.memberId,
      subscriptionId: trainerAbsencePushDeliveriesTable.subscriptionId,
      idempotencyKey: trainerAbsencePushDeliveriesTable.idempotencyKey,
    }).from(trainerAbsencePushDeliveriesTable).where(and(
      eq(trainerAbsencePushDeliveriesTable.absenceCourseId, absenceCourseId),
      or(
        inArray(trainerAbsencePushDeliveriesTable.status, ["pending", "failed"]),
        and(
          eq(trainerAbsencePushDeliveriesTable.status, "sending"),
          lt(trainerAbsencePushDeliveriesTable.claimedAt, new Date(now.getTime() - CLAIM_LEASE_MS)),
        ),
      ),
    )).for("update", { skipLocked: true });
    const claimed: Array<typeof rows[number] & { claimToken: string }> = [];
    for (const row of rows) {
      const claimToken = randomUUID();
      await tx.update(trainerAbsencePushDeliveriesTable).set({
        status: "sending", error: null, claimToken, claimedAt: now, attemptedAt: now,
        attemptCount: sql`${trainerAbsencePushDeliveriesTable.attemptCount} + 1`,
      }).where(eq(trainerAbsencePushDeliveriesTable.id, row.id));
      claimed.push({ ...row, claimToken });
    }
    return claimed;
  });

  const [decision] = await db.select({
    status: trainerAbsenceCoursesTable.status,
    courseId: trainerAbsenceCoursesTable.courseId,
    instructor: coursesTable.instructor,
    title: coursesTable.title,
  }).from(trainerAbsenceCoursesTable)
    .innerJoin(coursesTable, eq(trainerAbsenceCoursesTable.courseId, coursesTable.id))
    .where(eq(trainerAbsenceCoursesTable.id, absenceCourseId)).limit(1);
  for (const claim of claims) {
    let status: "sent" | "failed" | "skipped" = "failed";
    let error: string | null = null;
    let providerId: string | null = null;
    const [linked] = await db.select({ id: memberPushSubscriptionsTable.subscriptionId })
      .from(memberPushSubscriptionsTable).where(and(
        eq(memberPushSubscriptionsTable.subscriptionId, claim.subscriptionId),
        eq(memberPushSubscriptionsTable.memberId, claim.memberId),
      )).limit(1);
    if (!linked) {
      status = "skipped";
      error = "Push-Abo abgemeldet; In-App-Hinweis bleibt verfügbar.";
    } else if (!decision || !["replaced", "cancelled", "external"].includes(decision.status)) {
      error = "Kursentscheidung nicht mehr verfügbar.";
    } else {
      const notice = trainerDecisionNotice(decision.title, decision.status, decision.instructor);
      try {
        const response = await proxy("/notifications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: {
            app_id: APP_ID,
            include_subscription_ids: [claim.subscriptionId],
            target_channel: "push",
            headings: { en: notice.title },
            contents: { en: notice.body },
            data: { courseId: decision.courseId, memberId: claim.memberId },
            idempotency_key: claim.idempotencyKey,
          },
        });
        const result = await response.json().catch(() => ({})) as {
          id?: string; errors?: unknown; message?: string;
        };
        if (!response.ok) {
          error = result.message ?? `OneSignal HTTP ${response.status}.`;
        } else if (result.errors && (typeof result.errors !== "object" || Object.keys(result.errors).length > 0)) {
          error = "OneSignal hat die Zieladresse abgelehnt.";
        } else if (!result.id) {
          error = "OneSignal hat keine bestätigte Zustellung angenommen.";
        } else {
          status = "sent";
          providerId = result.id;
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "Push-Versand fehlgeschlagen.";
      }
    }
    await db.update(trainerAbsencePushDeliveriesTable).set({
      status, error, providerId, claimToken: null, claimedAt: null,
    }).where(and(
      eq(trainerAbsencePushDeliveriesTable.id, claim.id),
      eq(trainerAbsencePushDeliveriesTable.claimToken, claim.claimToken),
    ));
  }
}