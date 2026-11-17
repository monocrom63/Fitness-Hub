import { clerkClient } from "@clerk/express";
import { and, asc, eq } from "drizzle-orm";
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
  isSystemAdmin: boolean;
};

export function isSystemAdmin(staff: Pick<StaffContext, "isSystemAdmin">): boolean {
  return staff.isSystemAdmin;
}

export function isOrganizationAdmin(staff: Pick<StaffContext, "isSystemAdmin" | "role">): boolean {
  return staff.isSystemAdmin || staff.role === "district_manager";
}

function configuredSystemAdminEmails(): Set<string> {
  return new Set(
    (process.env.FIUDIA_SYSTEM_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}
const systemAdminIdentityCache = new Map<string, { email: string; verified: boolean; expiresAt: number }>();

async function hasConfiguredAdminIdentity(userId: string, storedEmail?: string): Promise<boolean> {
  const allowedEmails = configuredSystemAdminEmails();
  if (!allowedEmails.size || (storedEmail && !allowedEmails.has(storedEmail.trim().toLowerCase()))) return false;
  const cached = systemAdminIdentityCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.verified && allowedEmails.has(cached.email);
  try {
    const identity = await getClerkIdentity(userId);
    systemAdminIdentityCache.set(userId, {
      email: identity.email,
      verified: identity.emailVerified,
      expiresAt: Date.now() + 60_000,
    });
    return identity.emailVerified && allowedEmails.has(identity.email);
  } catch {
    return false;
  }
}

export function getRequestUserId(req: Request): string | null {
  return getAuth(req).userId ?? null;
}

export async function getRequestStaffContext(
  req: Request,
  database: Pick<typeof db, "select" | "insert"> = db,
  userIdOverride?: string | null,
): Promise<StaffContext | null> {
  const userId = userIdOverride === undefined ? getRequestUserId(req) : userIdOverride;
  if (!userId) return null;
  const rawOrganizationId = req.get("x-fiudia-organization-id");
  const parsedOrganizationId = rawOrganizationId ? Number(rawOrganizationId) : undefined;
  const requestedOrganizationId =
    parsedOrganizationId !== undefined && Number.isSafeInteger(parsedOrganizationId) && parsedOrganizationId > 0
      ? parsedOrganizationId
      : undefined;
  return getStaffContext(userId, database, requestedOrganizationId);
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
  database: Pick<typeof db, "select" | "insert"> = db,
  requestedOrganizationId?: number,
): Promise<StaffContext | null> {
  let [row] = await database
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

  const systemAdmin = await hasConfiguredAdminIdentity(clerkUserId, row?.email);
  if (systemAdmin && !row) {
    let identity;
    try { identity = await getClerkIdentity(clerkUserId); } catch { return null; }
    const [firstOrganization] = await database
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .orderBy(asc(organizationsTable.id))
      .limit(1);
    if (!firstOrganization) return null;
    await database.insert(staffTable).values({
      clerkUserId,
      organizationId: firstOrganization.id,
      studioId: null,
      fullName: identity.fullName,
      email: identity.email,
      role: "district_manager",
    }).onConflictDoNothing({ target: staffTable.clerkUserId });
    [row] = await database
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
      .innerJoin(organizationsTable, eq(staffTable.organizationId, organizationsTable.id))
      .leftJoin(studiosTable, eq(staffTable.studioId, studiosTable.id))
      .where(eq(staffTable.clerkUserId, clerkUserId))
      .limit(1);
    }

  if (!row || !ROLES.includes(row.role as FiudiaRole)) return null;
  if (systemAdmin && requestedOrganizationId !== undefined) {
    const [organization] = await database
      .select({ id: organizationsTable.id, name: organizationsTable.name })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, requestedOrganizationId))
      .limit(1);
    if (organization) {
      return {
        ...row,
        organizationId: organization.id,
        organizationName: organization.name,
        studioId: null,
        studioName: null,
        role: row.role as FiudiaRole,
        isSystemAdmin: true,
      };
    }
  }
  return { ...row, role: row.role as FiudiaRole, isSystemAdmin: systemAdmin };
}

export async function getAccessibleStudioIds(
  staff: StaffContext,
  database: Pick<typeof db, "select"> = db,
): Promise<number[]> {
  if (!isOrganizationAdmin(staff)) {
    return staff.studioId !== null && await canAccessStudio(staff, staff.studioId, database)
      ? [staff.studioId]
      : [];
  }

  const studios = await database
    .select({ id: studiosTable.id })
    .from(studiosTable)
    .where(eq(studiosTable.organizationId, staff.organizationId));
  return studios.map((studio) => studio.id);
}

export async function canAccessStudio(
  staff: StaffContext,
  studioId: number,
  database: Pick<typeof db, "select"> = db,
): Promise<boolean> {
  const [studio] = await database
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
  return isOrganizationAdmin(staff) || staff.studioId === studioId;
}

export function canManageTeam(staff: StaffContext): boolean {
  return isOrganizationAdmin(staff) || staff.role === "studio_manager";
}

export function canManageCourses(staff: StaffContext): boolean {
  return isOrganizationAdmin(staff) || staff.role === "studio_manager";
}