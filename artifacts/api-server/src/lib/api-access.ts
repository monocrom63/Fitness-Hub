import { and, desc, eq } from "drizzle-orm";
import { db, apiAccessRequestsTable } from "@workspace/db";

export async function getApprovedApiRequest(organizationId: number, serviceKey: string) {
  const [request] = await db.select().from(apiAccessRequestsTable).where(and(
    eq(apiAccessRequestsTable.organizationId, organizationId),
    eq(apiAccessRequestsTable.serviceKey, serviceKey),
    eq(apiAccessRequestsTable.status, "approved"),
  )).orderBy(desc(apiAccessRequestsTable.reviewedAt)).limit(1);
  return request ?? null;
}

export async function hasCurrentApprovedApiAccess(
  organizationId: number,
  serviceKey: string,
  keyCreatedAt?: Date | null,
) {
  const request = await getApprovedApiRequest(organizationId, serviceKey);
  if (!request) return false;
  if (keyCreatedAt && request.reviewedAt && keyCreatedAt < request.reviewedAt) return false;
  return true;
}
