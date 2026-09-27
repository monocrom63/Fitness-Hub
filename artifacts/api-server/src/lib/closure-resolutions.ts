import { and, eq, inArray } from "drizzle-orm";
import {
  closureEmailDeliveriesTable,
  closurePushDeliveriesTable,
  courseClosureResolutionsTable,
  coursesTable,
  db,
  roomClosuresTable,
} from "@workspace/db";

export async function listClosureResolutionsForStudio(
  studioId: number,
  closureId: number,
) {
  const rows = await db.select({
    resolutionId: courseClosureResolutionsTable.id,
    courseId: courseClosureResolutionsTable.courseId,
    courseTitle: coursesTable.title,
    action: courseClosureResolutionsTable.action,
    room: courseClosureResolutionsTable.targetRoom,
    channel: courseClosureResolutionsTable.channel,
  }).from(courseClosureResolutionsTable)
    .innerJoin(roomClosuresTable, eq(roomClosuresTable.id, courseClosureResolutionsTable.closureId))
    .innerJoin(coursesTable, eq(coursesTable.id, courseClosureResolutionsTable.courseId))
    .where(and(
      eq(roomClosuresTable.id, closureId),
      eq(roomClosuresTable.studioId, studioId),
      eq(coursesTable.studioId, studioId),
    ))
    .orderBy(courseClosureResolutionsTable.id);

  if (!rows.length) return [];
  const resolutionIds = rows.map(({ resolutionId }) => resolutionId);
  const emailDeliveries = await db.select({
    id: closureEmailDeliveriesTable.id,
    resolutionId: closureEmailDeliveriesTable.resolutionId,
    memberId: closureEmailDeliveriesTable.memberId,
    status: closureEmailDeliveriesTable.status,
    attemptCount: closureEmailDeliveriesTable.attemptCount,
    error: closureEmailDeliveriesTable.error,
    attemptedAt: closureEmailDeliveriesTable.attemptedAt,
  }).from(closureEmailDeliveriesTable)
    .where(inArray(closureEmailDeliveriesTable.resolutionId, resolutionIds))
    .orderBy(closureEmailDeliveriesTable.id);
  const pushDeliveries = await db.select({
    id: closurePushDeliveriesTable.id,
    resolutionId: closurePushDeliveriesTable.resolutionId,
    memberId: closurePushDeliveriesTable.memberId,
    status: closurePushDeliveriesTable.status,
    attemptCount: closurePushDeliveriesTable.attemptCount,
    error: closurePushDeliveriesTable.error,
    attemptedAt: closurePushDeliveriesTable.attemptedAt,
  }).from(closurePushDeliveriesTable)
    .where(inArray(closurePushDeliveriesTable.resolutionId, resolutionIds))
    .orderBy(closurePushDeliveriesTable.id);

  return rows.map((resolution) => {
    const rawDeliveries = resolution.channel === "push" ? pushDeliveries : emailDeliveries;
    const relatedDeliveries = rawDeliveries
      .filter((delivery) => delivery.resolutionId === resolution.resolutionId)
      .map(({ resolutionId: _resolutionId, ...delivery }) => delivery);
    const counts = {
      total: relatedDeliveries.length,
      pending: 0,
      sending: 0,
      sent: 0,
      failed: 0,
    };
    for (const delivery of relatedDeliveries) {
      if (delivery.status in counts && delivery.status !== "total") {
        counts[delivery.status as "pending" | "sending" | "sent" | "failed"] += 1;
      }
    }
    return {
      ...resolution,
      deliveryCounts: counts,
      deliveries: relatedDeliveries,
    };
  });
}