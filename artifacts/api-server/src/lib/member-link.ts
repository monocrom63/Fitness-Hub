import { and, eq, isNull, sql } from "drizzle-orm";
import { db, membersTable } from "@workspace/db";

export class MemberLinkError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Call only after verifying the signed-in account owns this primary email. */
export async function linkMembership(
  clerkUserId: string,
  verifiedEmail: string,
  memberId: number,
  database: typeof db = db,
) {
  const [existing] = await database.select({ id: membersTable.id })
    .from(membersTable).where(eq(membersTable.clerkUserId, clerkUserId)).limit(1);
  if (existing) {
    throw new MemberLinkError(409, "Dieses Konto ist bereits mit einer Mitgliedschaft verbunden.");
  }
  const [updated] = await database.update(membersTable)
    .set({ clerkUserId })
    .where(and(
      eq(membersTable.id, memberId),
      sql`lower(${membersTable.email}) = ${verifiedEmail.trim().toLowerCase()}`,
      isNull(membersTable.clerkUserId),
    )).returning({ id: membersTable.id });
  if (!updated) {
    throw new MemberLinkError(404, "Keine passende, noch freie Mitgliedschaft gefunden.");
  }
  return updated.id;
}