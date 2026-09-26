import { clerkClient } from "@clerk/express";
import { and, eq } from "drizzle-orm";
import type { Request } from "express";
import { db, organizationsTable, staffTable, studiosTable } from "@workspace/db";
import { getAuth } from "@clerk/express";

export const ROLES = [
  "district_manager",
  "studio_manager",
  "studio_employee",
] as const;
export type FiudiaRole = (typeof ROLES)[number];

export type StaffContext = {
  id: number;
  clerkUserId: string;
  organizationId: number;
  organizationName: string;
  studioId: number | null;
  studioName: string | null;
  fullName: string;
  email: string;
  role: FiudiaRole;
};

export function getRequestUserId(req: Request): string | null {
  return getAuth(req).userId ?? null;
}

export async function getClerkIdentity(userId: string) {
  const user = await clerkClient.users.getUser(userId);
  const email = user.primaryEmailAddress?.emailAddress?.trim().toLowerCase();
  if (!email) {
    throw new Error("The signed-in account has no primary email address.");
  }

  const fullName =
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
    user.username ||
    email.split("@")[0] ||
    "Fiudia Nutzer";

  return {
    userId,
    fullName,
    email,
    emailVerified: user.primaryEmailAddress?.verification?.status === "verified",
  };
}

export async function getStaffContext(
  clerkUserId: string,
): Promise<StaffContext | null> {
  const [row] = await db
    .select({
      id: staffTable.id,
      clerkUserId: staffTable.clerkUserId,
      organizationId: organizationsTable.id,
      organizationName: organizationsTable.name,
      studioId: studiosTable.id,
      studioName: studiosTable.name,
      fullName: staffTable.fullName,
      email: staffTable.email,
      role: staffTable.role,
    })
    .from(staffTable)
    .innerJoin(
      organizationsTable,
      eq(staffTable.organizationId, organizationsTable.id),
    )
    .leftJoin(studiosTable, eq(staffTable.studioId, studiosTable.id))
    .where(eq(staffTable.clerkUserId, clerkUserId))
    .limit(1);

  if (!row || !ROLES.includes(row.role as FiudiaRole)) {
    return null;
  }
  return { ...row, role: row.role as FiudiaRole };
}

export async function getAccessibleStudioIds(
  staff: StaffContext,
): Promise<number[]> {
  if (staff.role !== "district_manager") {
    return staff.studioId === null ? [] : [staff.studioId];
  }

  const studios = await db
    .select({ id: studiosTable.id })
    .from(studiosTable)
    .where(eq(studiosTable.organizationId, staff.organizationId));
  return studios.map((studio) => studio.id);
}

export async function canAccessStudio(
  staff: StaffContext,
  studioId: number,
): Promise<boolean> {
  const [studio] = await db
    .select({ id: studiosTable.id })
    .from(studiosTable)
    .where(
      and(
        eq(studiosTable.id, studioId),
        eq(studiosTable.organizationId, staff.organizationId),
      ),
    )
    .limit(1);

  if (!studio) return false;
  return staff.role === "district_manager" || staff.studioId === studioId;
}

export function canManageTeam(staff: StaffContext): boolean {
  return staff.role === "district_manager" || staff.role === "studio_manager";
}

export function canManageCourses(staff: StaffContext): boolean {
  return staff.role === "district_manager" || staff.role === "studio_manager";
}