import { and, eq, inArray } from "drizzle-orm";
import { courseEditPushDeliveriesTable, db } from "@workspace/db";

export async function supersedeCourseEditPushDeliveries(
  courseId: number,
  database: Pick<typeof db, "update"> = db,
) {
  // A sending record may already be in OneSignal. Leave it for the worker to
  // record its actual result; only work that has not started can be revoked.
  await database.update(courseEditPushDeliveriesTable).set({
    status: "skipped",
    error: "Superseded by a newer course change.",
    claimToken: null,
    claimedAt: null,
  }).where(and(
    eq(courseEditPushDeliveriesTable.courseId, courseId),
    inArray(courseEditPushDeliveriesTable.status, ["pending", "failed"]),
  ));
}