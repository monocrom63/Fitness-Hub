import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  AcceptInvitationParams,
  AcceptInvitationResponse,
  CreateInvitationBody,
  CreateInvitationResponse,
  ListInvitationsResponse,
} from "@workspace/api-zod";
import {
  db,
  invitationsTable,
  organizationsTable,
  staffTable,
  studiosTable,
} from "@workspace/db";
import {
  canAccessStudio,
  canManageTeam,
  getAccessibleStudioIds,
  getClerkIdentity,
  getRequestUserId,
  getStaffContext,
  type FiudiaRole,
  type StaffContext,
} from "../lib/fiudia-access";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.code === "23505" || candidate.cause?.code === "23505";
}

function invitationStatus(status: string, expiresAt: Date) {
  if (status === "pending" && expiresAt <= new Date()) return "expired";
  return status;
}

type TeamDependencies = {
  database: typeof db;
  userIdFromRequest: (req: Request) => string | null;
  identityForUser: typeof getClerkIdentity;
};

export function createTeamRouter(
  dependencies: Partial<TeamDependencies> = {},
): IRouter {
  const router: IRouter = Router();
  const database = dependencies.database ?? db;
  const userIdFromRequest = dependencies.userIdFromRequest ?? getRequestUserId;
  const identityForUser = dependencies.identityForUser ?? getClerkIdentity;

  async function requireManager(
    req: Request,
    res: Response,
  ): Promise<StaffContext | null> {
    const userId = userIdFromRequest(req);
    if (!userId) {
      res.status(401).json({ error: "Bitte melde dich an." });
      return null;
    }
    const staff = await getStaffContext(userId, database);
    if (!staff) {
      res.status(403).json({ error: "Für dieses Konto ist noch kein Fiudia-Zugang hinterlegt." });
      return null;
    }
    if (!canManageTeam(staff)) {
      res.status(403).json({ error: "Deine Rolle darf keine Teamzugänge verwalten." });
      return null;
    }
    return staff;
  }

router.get("/team/invitations", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const studioIds = await getAccessibleStudioIds(staff, database);
  if (studioIds.length === 0) {
    res.json([]);
    return;
  }

  const invitations = await database
    .select({
      id: invitationsTable.id,
      email: invitationsTable.email,
      role: invitationsTable.role,
      studioId: invitationsTable.studioId,
      studioName: studiosTable.name,
      status: invitationsTable.status,
      expiresAt: invitationsTable.expiresAt,
    })
    .from(invitationsTable)
    .innerJoin(
      studiosTable,
      and(
        eq(invitationsTable.studioId, studiosTable.id),
        eq(studiosTable.organizationId, staff.organizationId),
      ),
    )
    .where(
      and(
        eq(invitationsTable.organizationId, staff.organizationId),
        inArray(invitationsTable.studioId, studioIds),
      ),
    )
    .orderBy(desc(invitationsTable.createdAt))
    .limit(100);

  res.json(
    ListInvitationsResponse.parse(
      invitations.map((invitation) => ({
        ...invitation,
        status: invitationStatus(invitation.status, invitation.expiresAt),
        inviteUrl: "",
        expiresAt: invitation.expiresAt.toISOString(),
      })),
    ),
  );
});

router.post("/team/invitations", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const body = CreateInvitationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (
    staff.role === "studio_manager" &&
    body.data.role !== "studio_employee"
  ) {
    res.status(403).json({
      error: "Studioleitungen können nur Teammitarbeitende einladen.",
    });
    return;
  }
  if (!(await canAccessStudio(staff, body.data.studioId, database))) {
    res.status(403).json({ error: "Kein Zugriff auf dieses Studio." });
    return;
  }

  const email = body.data.email.trim().toLowerCase();
  const [existingStaff] = await database
    .select({ id: staffTable.id })
    .from(staffTable)
    .where(
      and(
        eq(staffTable.organizationId, staff.organizationId),
        eq(staffTable.email, email),
      ),
    )
    .limit(1);
  if (existingStaff) {
    res.status(409).json({ error: "Diese Person hat bereits einen Teamzugang." });
    return;
  }
  const [existingInvitation] = await database
    .select({ id: invitationsTable.id })
    .from(invitationsTable)
    .where(
      and(
        eq(invitationsTable.organizationId, staff.organizationId),
        eq(invitationsTable.email, email),
        eq(invitationsTable.status, "pending"),
        gt(invitationsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (existingInvitation) {
    res.status(409).json({ error: "Für diese E-Mail ist bereits eine Einladung offen." });
    return;
  }

  const rawToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [invitation] = await database
    .insert(invitationsTable)
    .values({
      organizationId: staff.organizationId,
      studioId: body.data.studioId,
      invitedByStaffId: staff.id,
      email,
      role: body.data.role,
      tokenHash: hashToken(rawToken),
      expiresAt,
    })
    .returning();
  const [studio] = await database
    .select({ name: studiosTable.name })
    .from(studiosTable)
    .where(eq(studiosTable.id, invitation.studioId))
    .limit(1);

  res.status(201).json(
    CreateInvitationResponse.parse({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      studioId: invitation.studioId,
      studioName: studio.name,
      status: invitation.status,
      inviteUrl: `/invite/${rawToken}`,
      expiresAt: invitation.expiresAt.toISOString(),
    }),
  );
});

router.post(
  "/team/invitations/:token/accept",
  async (req, res): Promise<void> => {
    const userId = userIdFromRequest(req);
    if (!userId) {
      res.status(401).json({ error: "Bitte melde dich an." });
      return;
    }
    const params = AcceptInvitationParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Einladung nicht gefunden." });
      return;
    }
    const identity = await identityForUser(userId);
    if (!identity.emailVerified) {
      res.status(403).json({ error: "Bestätige zuerst deine E-Mail-Adresse." });
      return;
    }
    if (await getStaffContext(userId, database)) {
      res.status(409).json({ error: "Für dieses Konto besteht bereits ein Fiudia-Zugang." });
      return;
    }

    const [invitation] = await database
      .select()
      .from(invitationsTable)
      .where(eq(invitationsTable.tokenHash, hashToken(params.data.token)))
      .limit(1);
    if (
      !invitation ||
      invitation.status !== "pending" ||
      invitation.expiresAt <= new Date()
    ) {
      res.status(404).json({ error: "Die Einladung ist abgelaufen oder wurde bereits verwendet." });
      return;
    }
    if (identity.email !== invitation.email.toLowerCase()) {
      res.status(403).json({
        error: "Melde dich mit der E-Mail-Adresse an, an die die Einladung gesendet wurde.",
      });
      return;
    }

    const role = invitation.role as FiudiaRole;
    let uniqueConflict = false;
    const created = await database.transaction(async (tx) => {
        // Never consume an invitation if its studio no longer belongs to its organization.
        const [targetStudio] = await tx
          .select({ id: studiosTable.id })
          .from(studiosTable)
          .where(
            and(
              eq(studiosTable.id, invitation.studioId),
              eq(studiosTable.organizationId, invitation.organizationId),
            ),
          )
          .limit(1);
        if (!targetStudio) return null;
        const [accepted] = await tx
          .update(invitationsTable)
          .set({ status: "accepted" })
          .where(
            and(
              eq(invitationsTable.id, invitation.id),
              eq(invitationsTable.status, "pending"),
              gt(invitationsTable.expiresAt, new Date()),
            ),
          )
          .returning({ id: invitationsTable.id });
        if (!accepted) return null;

        const [member] = await tx
          .insert(staffTable)
          .values({
            clerkUserId: userId,
            organizationId: invitation.organizationId,
            studioId: invitation.studioId,
            fullName: identity.fullName,
            email: identity.email,
            role,
          })
          .returning();
        const [studio] = await tx
          .select({
            studioName: studiosTable.name,
            organizationName: organizationsTable.name,
          })
          .from(studiosTable)
          .innerJoin(
            organizationsTable,
            eq(studiosTable.organizationId, organizationsTable.id),
          )
          .where(eq(studiosTable.id, invitation.studioId))
          .limit(1);
      return { member, studio };
    }).catch((error) => {
      // A second invite can race for the same Clerk identity. The unique
      // identity constraint rolls back that transaction, including its invite.
      if (!isUniqueViolation(error)) throw error;
      uniqueConflict = true;
      return null;
    });
    if (uniqueConflict) {
      res.status(409).json({ error: "Für dieses Konto besteht bereits ein Fiudia-Zugang." });
      return;
    }
    if (!created) {
      res.status(404).json({ error: "Die Einladung ist abgelaufen oder wurde bereits verwendet." });
      return;
    }

    res.json(
      AcceptInvitationResponse.parse({
        userId,
        userName: created.member.fullName,
        email: created.member.email,
        isOnboarded: true,
        role: created.member.role,
        organizationId: created.member.organizationId,
        organizationName: created.studio.organizationName,
        studioId: created.member.studioId,
        studioName: created.studio.studioName,
      }),
    );
  },
);

  return router;
}

export default createTeamRouter();