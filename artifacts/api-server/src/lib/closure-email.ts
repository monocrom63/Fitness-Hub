import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  closureEmailDeliveriesTable,
  courseClosureResolutionsTable,
  coursesTable,
  db,
} from "@workspace/db";
import { resendRequest, type ResendRequest } from "./resend-client";
import { WAITLIST_EMAIL_SENDER } from "./waitlist-email";

const CLAIM_LEASE_MS = 5 * 60 * 1000;

export function closureEmailSender(configured = process.env.RESEND_FROM_EMAIL): string {
  return configured ?? WAITLIST_EMAIL_SENDER;
}

/**
 * Check provider configuration before changing a course. This cannot guarantee
 * delivery later; failed sends remain in the durable delivery queue.
 */
export async function closureEmailReadiness(
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
    // A valid sending-only key may not have permission to list domains. Allow
    // the attempt in that case; the actual send still records its outcome.
    if (response.status === 403) return null;
    if (!response.ok) return "E-Mail ist derzeit nicht versandbereit. Bitte In-App wählen; der Kurs wurde nicht geändert.";
    const result = await response.json() as { data?: Array<{ name: string; status: string }> };
    if (!Array.isArray(result.data)) {
      return "Die E-Mail-Absenderdomain konnte nicht geprüft werden. Bitte In-App wählen.";
    }
    if (!result.data.some((entry) => entry.name.toLowerCase() === domain && entry.status === "verified")) {
      return "Die E-Mail-Absenderdomain ist noch nicht verifiziert. Bitte In-App wählen.";
    }
    return null;
  } catch {
    return "Der E-Mail-Anbieter ist derzeit nicht erreichbar. Bitte In-App wählen; der Kurs wurde nicht geändert.";
  }
}

type ClaimableDelivery = {
  id: number;
  email: string;
  claimToken: string;
};

export async function claimResolutionEmailDeliveries(resolutionId: number) {
  return db.transaction(async (tx) => {
    const now = new Date();
    const reclaimBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
    const claimable = await tx.select({
      id: closureEmailDeliveriesTable.id,
      email: closureEmailDeliveriesTable.email,
    }).from(closureEmailDeliveriesTable).where(and(
      eq(closureEmailDeliveriesTable.resolutionId, resolutionId),
      or(
        inArray(closureEmailDeliveriesTable.status, ["pending", "failed"]),
        and(
          eq(closureEmailDeliveriesTable.status, "sending"),
          lt(closureEmailDeliveriesTable.claimedAt, reclaimBefore),
        ),
      ),
    )).for("update", { skipLocked: true });

    const claims: ClaimableDelivery[] = [];
    for (const delivery of claimable) {
      const claimToken = randomUUID();
      const [claimed] = await tx.update(closureEmailDeliveriesTable).set({
        status: "sending",
        error: null,
        providerId: null,
        claimToken,
        claimedAt: now,
        attemptedAt: now,
        attemptCount: sql`${closureEmailDeliveriesTable.attemptCount} + 1`,
      }).where(eq(closureEmailDeliveriesTable.id, delivery.id)).returning({
        id: closureEmailDeliveriesTable.id,
        email: closureEmailDeliveriesTable.email,
      });
      if (claimed) claims.push({ ...claimed, claimToken });
    }
    return claims;
  });
}

async function sendOne(
  delivery: ClaimableDelivery,
  resolutionId: number,
  request: ResendRequest,
  sender: string,
) {
  const [resolution] = await db.select({
    action: courseClosureResolutionsTable.action,
    targetRoom: courseClosureResolutionsTable.targetRoom,
    courseId: courseClosureResolutionsTable.courseId,
  }).from(courseClosureResolutionsTable)
    .where(eq(courseClosureResolutionsTable.id, resolutionId))
    .limit(1);
  if (!resolution) {
    return { status: "failed" as const, detail: "Course resolution no longer exists." };
  }
  const [course] = await db.select({
    title: coursesTable.title,
  }).from(coursesTable)
    .where(eq(coursesTable.id, resolution.courseId))
    .limit(1);
  if (!course) return { status: "failed" as const, detail: "Resolved course no longer exists." };

  const subject = resolution.action === "cancel"
    ? "Dein Kurs wurde storniert"
    : "Der Kursraum wurde geändert";
  const text = resolution.action === "cancel"
    ? `Der Kurs „${course.title}“ wurde wegen einer Raumschließung abgesagt.`
    : `Der Kurs „${course.title}“ findet wegen einer Raumschließung nun in ${resolution.targetRoom} statt.`;
  try {
    const response = await request("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Stable across lease recovery/retries to make ambiguous provider
        // outcomes idempotent at Resend.
        "Idempotency-Key": `fiudia-closure-delivery-${delivery.id}`,
      },
      body: JSON.stringify({ from: sender, to: [delivery.email], subject, text }),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json().catch(() => ({})) as { id?: string; message?: string };
    if (!response.ok) {
      return {
        status: "failed" as const,
        detail: result.message ?? `Resend returned HTTP ${response.status}.`,
      };
    }
    return { status: "sent" as const, detail: null, providerId: result.id ?? null };
  } catch (error) {
    return {
      status: "failed" as const,
      detail: error instanceof Error ? error.message : "Email delivery failed.",
    };
  }
}

type ResolutionEmailOptions = {
  request?: ResendRequest;
  sender?: string;
};

export async function processResolutionEmails(
  resolutionId: number,
  options: ResolutionEmailOptions = {},
) {
  const request = options.request ?? resendRequest;
  const sender = options.sender ?? closureEmailSender();
  const claims = await claimResolutionEmailDeliveries(resolutionId);
  for (const claim of claims) {
    const outcome = await sendOne(claim, resolutionId, request, sender);
    await db.update(closureEmailDeliveriesTable).set({
      status: outcome.status,
      error: outcome.detail,
      providerId: "providerId" in outcome ? outcome.providerId : null,
      claimToken: null,
      claimedAt: null,
    }).where(and(
      eq(closureEmailDeliveriesTable.id, claim.id),
      eq(closureEmailDeliveriesTable.claimToken, claim.claimToken),
    ));
  }
  return db.select({
    id: closureEmailDeliveriesTable.id,
    memberId: closureEmailDeliveriesTable.memberId,
    status: closureEmailDeliveriesTable.status,
    attemptCount: closureEmailDeliveriesTable.attemptCount,
    error: closureEmailDeliveriesTable.error,
    attemptedAt: closureEmailDeliveriesTable.attemptedAt,
  }).from(closureEmailDeliveriesTable)
    .where(eq(closureEmailDeliveriesTable.resolutionId, resolutionId))
    .orderBy(closureEmailDeliveriesTable.id);
}

export async function getResolutionEmailStatuses(resolutionId: number) {
  return db.select({
    id: closureEmailDeliveriesTable.id,
    memberId: closureEmailDeliveriesTable.memberId,
    status: closureEmailDeliveriesTable.status,
    attemptCount: closureEmailDeliveriesTable.attemptCount,
    error: closureEmailDeliveriesTable.error,
    attemptedAt: closureEmailDeliveriesTable.attemptedAt,
  }).from(closureEmailDeliveriesTable)
    .where(eq(closureEmailDeliveriesTable.resolutionId, resolutionId))
    .orderBy(closureEmailDeliveriesTable.id);
}