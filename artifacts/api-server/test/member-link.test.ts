import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { db, membersTable, organizationsTable, pool, studiosTable } from "@workspace/db";
import { linkMembership, MemberLinkError } from "../src/lib/member-link";

const rollback = Symbol("rollback membership fixture");

test("membership linking requires a matching email and is exclusive", async () => {
  try {
    await db.transaction(async (tx) => {
      const suffix = randomUUID();
      const [org] = await tx.insert(organizationsTable)
        .values({ name: `Membership test ${suffix}` }).returning();
      const [studio] = await tx.insert(studiosTable)
        .values({ organizationId: org.id, name: "Test", city: "Berlin" }).returning();
      const [first, second] = await tx.insert(membersTable).values([
        { studioId: studio.id, fullName: "First", email: `First-${suffix}@example.invalid`, membershipType: "Basic" },
        { studioId: studio.id, fullName: "Second", email: `second-${suffix}@example.invalid`, membershipType: "Basic" },
      ]).returning();
      const database = tx as unknown as typeof db;
      const wrongEmail = () => linkMembership("clerk-first", second.email, first.id, database);
      await assert.rejects(wrongEmail(),
        (error) => error instanceof MemberLinkError && error.status === 404);
      const [notLinked] = await tx.select().from(membersTable).where(eq(membersTable.id, first.id));
      assert.equal(notLinked.clerkUserId, null);

      assert.equal(
        await linkMembership("clerk-first", first.email.toLowerCase(), first.id, database),
        first.id,
      );
      await assert.rejects(linkMembership("clerk-other", first.email, first.id, database),
        (error) => error instanceof MemberLinkError && error.status === 404);
      await assert.rejects(linkMembership("clerk-first", second.email, second.id, database),
        (error) => error instanceof MemberLinkError && error.status === 409);
      const [stillUnlinked] = await tx.select().from(membersTable).where(eq(membersTable.id, second.id));
      assert.equal(stillUnlinked.clerkUserId, null);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await pool.end();
  }
});