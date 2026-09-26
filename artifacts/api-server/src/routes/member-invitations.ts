import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import {
  AcceptMemberInvitationBody,
  AcceptMemberInvitationResponse,
  CreateMemberInvitationParams,
  CreateMemberInvitationResponse,
} from "@workspace/api-zod";
import {
  db,
  memberInvitationsTable,
  membersTable,
  staffTable,
  studiosTable,
} from "@workspace/db";
import {
  canAccessStudio,
  getClerkIdentity,
  getRequestUserId,
  getStaffContext,
  type StaffContext,
} from "../lib/fiudia-access";
import { isModuleEnabled } from "../lib/module-access";
import { linkedMember, memberHome } from "./member-app";

type MemberInvitationDependencies = {
  database: typeof db;
  userIdFromRequest: (req: Request) => string | null;
  identityForUser: typeof getClerkIdentity;
  staffForUser: typeof getStaffContext;
  moduleEnabled: typeof isModuleEnabled;
};

class MemberInvitationError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isRealEmail(email: string): boolean {
  return CreateMemberInvitationResponse.shape.memberEmail.safeParse(email).success;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.code === "23505" || candidate.cause?.code === "23505";
}

export function createMemberInvitationsRouter(
  dependencies: Partial<MemberInvitationDependencies> = {},
): IRouter {
  const router: IRouter = Router();
  const database = dependencies.database ?? db;
  const userIdFromRequest = dependencies.userIdFromRequest ?? getRequestUserId;
  const identityForUser = dependencies.identityForUser ?? getClerkIdentity;
  const staffForUser = dependencies.staffForUser ?? getStaffContext;
  const moduleEnabled = dependencies.moduleEnabled ?? isModuleEnabled;

  async function requireManager(req: Request, res: import("express").Response): Promise<StaffContext | null> {
    const userId = userIdFromRequest(req);
    if (!userId) {
      res.status(401).json({ error: "Bitte melde dich an." });
      return null;
    }
    const staff = await staffForUser(userId, database);
    if (!staff) {
      res.status(403).json({ error: "Für dieses Konto ist noch kein Fiudia-Zugang hinterlegt." });
      return null;
    }
    if (staff.role !== "district_manager" && staff.role !== "studio_manager") {
      res.status(403).json({ error: "Deine Rolle darf keine Mitgliedereinladungen erstellen." });
      return null;
    }
    return staff;
  }

  router.post("/members/:id/invite", async (req, res): Promise<void> => {
    const staff = await requireManager(req, res);
    if (!staff) return;
    const params = CreateMemberInvitationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Ungültiges Mitglied." });
      return;
    }

    const [initialMember] = await database.select({
      id: membersTable.id,
      studioId: membersTable.studioId,
    }).from(membersTable)
      .where(eq(membersTable.id, params.data.id)).limit(1);
    if (!initialMember) {
      res.status(404).json({ error: "Mitglied nicht gefunden." });
      return;
    }
    if (!(await canAccessStudio(staff, initialMember.studioId, database))) {
      res.status(403).json({ error: "Kein Zugriff auf dieses Studio." });
      return;
    }

    const rawToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    try {
      const invitation = await database.transaction(async (tx) => {
        const [member] = await tx.select().from(membersTable)
          .where(eq(membersTable.id, params.data.id)).limit(1).for("update");
        if (!member) throw new MemberInvitationError(404, "Mitglied nicht gefunden.");
        if (!(await canAccessStudio(staff, member.studioId, tx))) {
          throw new MemberInvitationError(403, "Kein Zugriff auf dieses Studio.");
        }
        if (member.status !== "active") {
          throw new MemberInvitationError(409, "Nur aktive Mitglieder können eingeladen werden.");
        }
        if (member.clerkUserId !== null) {
          throw new MemberInvitationError(409, "Dieses Mitglied hat bereits ein verknüpftes Konto.");
        }
        const memberEmail = member.email?.trim().toLowerCase();
        if (!memberEmail || !isRealEmail(memberEmail)) {
          throw new MemberInvitationError(409, "Für dieses Mitglied ist keine gültige E-Mail-Adresse hinterlegt.");
        }

        await tx.update(memberInvitationsTable)
          .set({ status: "revoked" })
          .where(and(
            eq(memberInvitationsTable.memberId, member.id),
            eq(memberInvitationsTable.status, "pending"),
          ));
        await tx.insert(memberInvitationsTable).values({
          memberId: member.id,
          invitedByStaffId: staff.id,
          studioId: member.studioId,
          email: memberEmail,
          tokenHash: hashToken(rawToken),
          expiresAt,
        });
        return { fullName: member.fullName, email: memberEmail };
      });

      res.status(201).json(CreateMemberInvitationResponse.parse({
        inviteUrl: `/fiudia-members/invite/${rawToken}`,
        expiresAt,
        memberName: invitation.fullName,
        memberEmail: invitation.email,
      }));
    } catch (error) {
      if (error instanceof MemberInvitationError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  router.post("/member/invitations/accept", async (req, res): Promise<void> => {
    const userId = userIdFromRequest(req);
    if (!userId) {
      res.status(401).json({ error: "Bitte melde dich an." });
      return;
    }
    const body = AcceptMemberInvitationBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Ungültiger Einladungstoken." });
      return;
    }
    const identity = await identityForUser(userId);
    if (!identity.emailVerified) {
      res.status(403).json({ error: "Bitte bestätige zuerst deine E-Mail-Adresse." });
      return;
    }

    try {
      await database.transaction(async (tx) => {
        const [tokenMatch] = await tx.select({
          id: memberInvitationsTable.id,
          memberId: memberInvitationsTable.memberId,
        }).from(memberInvitationsTable)
          .where(eq(memberInvitationsTable.tokenHash, hashToken(body.data.token)))
          .limit(1);
        if (!tokenMatch) {
          throw new MemberInvitationError(404, "Einladung nicht gefunden.");
        }

        // Reissue locks the member before touching invitation rows. Keep this
        // lock order identical to avoid a member/invitation lock inversion.
        const [member] = await tx.select().from(membersTable)
          .where(eq(membersTable.id, tokenMatch.memberId)).limit(1).for("update");
        if (!member) throw new MemberInvitationError(404, "Mitglied nicht gefunden.");

        const [invitation] = await tx.select().from(memberInvitationsTable)
          .where(eq(memberInvitationsTable.id, tokenMatch.id))
          .limit(1).for("update");
        if (!invitation || invitation.memberId !== member.id) {
          throw new MemberInvitationError(404, "Einladung nicht gefunden.");
        }
        if (invitation.status !== "pending") {
          throw new MemberInvitationError(409, "Diese Einladung wurde bereits verwendet oder widerrufen.");
        }
        if (invitation.expiresAt <= new Date()) {
          throw new MemberInvitationError(404, "Diese Einladung ist abgelaufen.");
        }

        if (member.status !== "active" || member.clerkUserId !== null) {
          throw new MemberInvitationError(409, "Dieses Mitglied kann nicht mehr verknüpft werden.");
        }
        if (member.studioId !== invitation.studioId) {
          throw new MemberInvitationError(409, "Das Mitglied wurde seit der Einladung einem anderen Studio zugeordnet.");
        }
        if (
          !member.email ||
          member.email.trim().toLowerCase() !== invitation.email ||
          identity.email.trim().toLowerCase() !== invitation.email
        ) {
          throw new MemberInvitationError(403, "Melde dich mit der bestätigten E-Mail-Adresse des Mitglieds an.");
        }

        const [ownership] = await tx.select({
          studioOrganizationId: studiosTable.organizationId,
          inviterOrganizationId: staffTable.organizationId,
        }).from(studiosTable)
          .innerJoin(staffTable, eq(staffTable.id, invitation.invitedByStaffId))
          .where(eq(studiosTable.id, invitation.studioId))
          .limit(1);
        if (!ownership || ownership.studioOrganizationId !== ownership.inviterOrganizationId) {
          throw new MemberInvitationError(404, "Einladung nicht gefunden.");
        }
        if (!(await moduleEnabled(ownership.inviterOrganizationId, "members", tx))) {
          throw new MemberInvitationError(403, "Dieses Modul ist für die Organisation nicht aktiviert.");
        }

        const [alreadyLinked] = await tx.select({ id: membersTable.id })
          .from(membersTable).where(eq(membersTable.clerkUserId, userId)).limit(1);
        if (alreadyLinked) {
          throw new MemberInvitationError(409, "Dieses Konto ist bereits mit einer Mitgliedschaft verbunden.");
        }
        const [claimed] = await tx.update(membersTable)
          .set({ clerkUserId: userId })
          .where(and(
            eq(membersTable.id, member.id),
            eq(membersTable.status, "active"),
            isNull(membersTable.clerkUserId),
            sql`lower(${membersTable.email}) = ${invitation.email}`,
          ))
          .returning({ id: membersTable.id });
        if (!claimed) {
          throw new MemberInvitationError(409, "Dieses Mitglied wurde inzwischen verknüpft oder geändert.");
        }

        const [consumed] = await tx.update(memberInvitationsTable)
          .set({ status: "accepted" })
          .where(and(
            eq(memberInvitationsTable.id, invitation.id),
            eq(memberInvitationsTable.status, "pending"),
            gt(memberInvitationsTable.expiresAt, new Date()),
          ))
          .returning({ id: memberInvitationsTable.id });
        if (!consumed) {
          throw new MemberInvitationError(409, "Diese Einladung wurde inzwischen verwendet oder ist abgelaufen.");
        }
      });
    } catch (error) {
      if (error instanceof MemberInvitationError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (isUniqueViolation(error)) {
        res.status(409).json({ error: "Dieses Konto ist bereits mit einer Mitgliedschaft verbunden." });
        return;
      }
      throw error;
    }

    res.json(AcceptMemberInvitationResponse.parse(await memberHome(await linkedMember(userId))));
  });

  return router;
}

export default createMemberInvitationsRouter();