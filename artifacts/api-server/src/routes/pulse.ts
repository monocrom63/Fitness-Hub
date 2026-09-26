import { and, count, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreatePulseMessageBody,
  CreatePulseMessageResponse,
  ListPulseResponse,
  MarkPulseReadParams,
  MarkPulseReadResponse,
} from "@workspace/api-zod";
import {
  db,
  pulseMessagesTable,
  pulseReadsTable,
  staffTable,
  studiosTable,
} from "@workspace/db";
import {
  canAccessStudio,
  canManageTeam,
  getAccessibleStudioIds,
  getRequestUserId,
  getStaffContext,
  type StaffContext,
} from "../lib/fiudia-access";

function visibleMessages(staff: StaffContext, studioIds: number[]) {
  const locationFilter = studioIds.length
    ? or(
        isNull(pulseMessagesTable.studioId),
        inArray(pulseMessagesTable.studioId, studioIds),
      )
    : isNull(pulseMessagesTable.studioId);
  const roleAudience =
    staff.role === "studio_employee" ? "employees" : "managers";

  return and(
    eq(pulseMessagesTable.organizationId, staff.organizationId),
    locationFilter,
    or(
      eq(pulseMessagesTable.audience, "all"),
      eq(pulseMessagesTable.audience, roleAudience),
      eq(pulseMessagesTable.authorStaffId, staff.id),
    ),
  );
}

type PulseDependencies = {
  database: typeof db;
  userIdFromRequest: (req: Request) => string | null;
};

export function createPulseRouter(
  dependencies: Partial<PulseDependencies> = {},
): IRouter {
  const router: IRouter = Router();
  const database = dependencies.database ?? db;
  const userIdFromRequest = dependencies.userIdFromRequest ?? getRequestUserId;

  async function requireStaff(
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
    return staff;
  }

router.get("/pulse", async (req, res): Promise<void> => {
  const staff = await requireStaff(req, res);
  if (!staff) return;

  const studioIds = await getAccessibleStudioIds(staff, database);
  const messages = await database
    .select({
      id: pulseMessagesTable.id,
      title: pulseMessagesTable.title,
      body: pulseMessagesTable.body,
      priority: pulseMessagesTable.priority,
      audience: pulseMessagesTable.audience,
      studioId: pulseMessagesTable.studioId,
      studioName: studiosTable.name,
      authorName: staffTable.fullName,
      createdAt: pulseMessagesTable.createdAt,
    })
    .from(pulseMessagesTable)
    .innerJoin(staffTable, eq(pulseMessagesTable.authorStaffId, staffTable.id))
    .leftJoin(studiosTable, eq(pulseMessagesTable.studioId, studiosTable.id))
    .where(visibleMessages(staff, studioIds))
    .orderBy(desc(pulseMessagesTable.createdAt))
    .limit(60);

  const messageIds = messages.map((message) => message.id);
  const readCounts = messageIds.length
    ? await database
        .select({
          messageId: pulseReadsTable.messageId,
          total: count(),
        })
        .from(pulseReadsTable)
        .where(inArray(pulseReadsTable.messageId, messageIds))
        .groupBy(pulseReadsTable.messageId)
    : [];
  const ownReads = messageIds.length
    ? await database
        .select({ messageId: pulseReadsTable.messageId })
        .from(pulseReadsTable)
        .where(
          and(
            inArray(pulseReadsTable.messageId, messageIds),
            eq(pulseReadsTable.staffId, staff.id),
          ),
        )
    : [];
  const totals = new Map(readCounts.map((row) => [row.messageId, row.total]));
  const readIds = new Set(ownReads.map((row) => row.messageId));

  res.json(
    ListPulseResponse.parse(
      messages.map((message) => ({
        ...message,
        createdAt: message.createdAt.toISOString(),
        isRead: readIds.has(message.id),
        readCount: totals.get(message.id) ?? 0,
      })),
    ),
  );
});

router.post("/pulse", async (req, res): Promise<void> => {
  const staff = await requireStaff(req, res);
  if (!staff) return;
  if (!canManageTeam(staff)) {
    res.status(403).json({ error: "Nur Leitungen können Pulse-Meldungen veröffentlichen." });
    return;
  }

  const body = CreatePulseMessageBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const title = body.data.title.trim();
  const content = body.data.body.trim();
  if (title.length < 2 || !content) {
    res.status(400).json({ error: "Titel und Nachricht dürfen nicht leer sein." });
    return;
  }
  const studioId = body.data.studioId;
  if (studioId === null && staff.role !== "district_manager") {
    res.status(403).json({ error: "Nur Bezirksleitungen können organisationsweit schreiben." });
    return;
  }
  if (studioId !== null && !(await canAccessStudio(staff, studioId, database))) {
    res.status(403).json({ error: "Kein Zugriff auf dieses Studio." });
    return;
  }

  const message = await database.transaction(async (tx) => {
    const [created] = await tx
      .insert(pulseMessagesTable)
      .values({
        organizationId: staff.organizationId,
        studioId,
        authorStaffId: staff.id,
        title,
        body: content,
        priority: body.data.priority,
        audience: body.data.audience,
      })
      .returning();
    await tx
      .insert(pulseReadsTable)
      .values({ messageId: created.id, staffId: staff.id });
    return created;
  });
  const [studio] = studioId === null
    ? [null]
    : await database
        .select({ name: studiosTable.name })
        .from(studiosTable)
        .where(eq(studiosTable.id, studioId))
        .limit(1);

  res.status(201).json(
    CreatePulseMessageResponse.parse({
      id: message.id,
      title: message.title,
      body: message.body,
      priority: message.priority,
      audience: message.audience,
      studioId: message.studioId,
      studioName: studio?.name ?? null,
      authorName: staff.fullName,
      createdAt: message.createdAt.toISOString(),
      isRead: true,
      readCount: 1,
    }),
  );
});

router.post("/pulse/:id/read", async (req, res): Promise<void> => {
  const staff = await requireStaff(req, res);
  if (!staff) return;
  const params = MarkPulseReadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Ungültige Meldungs-ID." });
    return;
  }

  const studioIds = await getAccessibleStudioIds(staff, database);
  const [message] = await database
    .select({ id: pulseMessagesTable.id })
    .from(pulseMessagesTable)
    .where(
      and(
        eq(pulseMessagesTable.id, params.data.id),
        visibleMessages(staff, studioIds),
      ),
    )
    .limit(1);
  if (!message) {
    res.status(404).json({ error: "Meldung nicht gefunden." });
    return;
  }

  await database
    .insert(pulseReadsTable)
    .values({ messageId: message.id, staffId: staff.id })
    .onConflictDoNothing();
  const [receipt] = await database
    .select({ readAt: pulseReadsTable.readAt })
    .from(pulseReadsTable)
    .where(
      and(
        eq(pulseReadsTable.messageId, message.id),
        eq(pulseReadsTable.staffId, staff.id),
      ),
    )
    .limit(1);
  res.json(
    MarkPulseReadResponse.parse({
      messageId: message.id,
      readAt: receipt.readAt.toISOString(),
    }),
  );
});

  return router;
}

export default createPulseRouter();