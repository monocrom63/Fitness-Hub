import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateApiAccessRequestBody, CreateApiAccessRequestResponse,
  ListApiAccessRequestsResponse, ListApiCatalogResponse,
  ReviewApiAccessRequestBody, ReviewApiAccessRequestParams,
  ReviewApiAccessRequestResponse,
} from "@workspace/api-zod";
import {
  apiAccessRequestsTable, db, marketingApiKeysTable, staffTable,
} from "@workspace/db";
import { getRequestUserId, getStaffContext, type StaffContext } from "../lib/fiudia-access";
import { isModuleEnabled } from "../lib/module-access";

const router: IRouter = Router();
const services = [
  { serviceKey: "personio", title: "Personio", description: "Mitarbeiter- und Organisationsdaten für HR-Prozesse.", availability: "planned" },
  { serviceKey: "marketing", title: "Marketing / Social Media", description: "Anonyme Zielgruppenreichweiten für freigegebene Marketingkampagnen.", availability: "available" },
  { serviceKey: "access", title: "Zutritt Software", description: "Zutrittsereignisse und Berechtigungen aus angebundener Zutrittssoftware.", availability: "planned" },
  { serviceKey: "accounting", title: "Finanzbuchhaltung", description: "Finanz- und Buchhaltungsdaten für angebundene Systeme.", availability: "planned" },
] as const;
const serviceTitles = new Map(services.map((service) => [service.serviceKey, service.title]));

async function requireManager(req: Request, res: Response): Promise<StaffContext | null> {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Bitte melde dich an." }); return null; }
  const staff = await getStaffContext(userId);
  if (!staff) { res.status(403).json({ error: "Für dieses Konto ist kein Fiudia-Zugang hinterlegt." }); return null; }
  if (staff.role === "studio_employee") { res.status(403).json({ error: "REST-API-Zugänge sind nur für Studio- und Bezirksleitungen verfügbar." }); return null; }
  return staff;
}

async function requestResponse(row: typeof apiAccessRequestsTable.$inferSelect) {
  const [requester] = await db.select({ name: staffTable.fullName, email: staffTable.email })
    .from(staffTable).where(eq(staffTable.id, row.requestedByStaffId)).limit(1);
  return {
    id: row.id,
    serviceKey: row.serviceKey,
    serviceTitle: serviceTitles.get(row.serviceKey as typeof services[number]["serviceKey"]) ?? row.serviceKey,
    reason: row.reason,
    status: row.status,
    requestedBy: requester?.name ?? "Fiudia Nutzer",
    requestedByEmail: requester?.email ?? "unbekannt@fiudia.invalid",
    createdAt: row.createdAt,
    reviewNote: row.reviewNote,
    reviewedAt: row.reviewedAt,
  };
}

router.get("/api-access/catalog", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const requests = await db.select().from(apiAccessRequestsTable)
    .where(eq(apiAccessRequestsTable.organizationId, staff.organizationId))
    .orderBy(desc(apiAccessRequestsTable.createdAt));
  const latestByService = new Map<string, typeof requests[number]>();
  for (const request of requests) if (!latestByService.has(request.serviceKey)) latestByService.set(request.serviceKey, request);
  const [marketingKey] = await db.select().from(marketingApiKeysTable)
    .where(eq(marketingApiKeysTable.organizationId, staff.organizationId)).limit(1);
  const marketingAccess = latestByService.get("marketing");
  const marketingPaid = await isModuleEnabled(staff.organizationId, "marketing");
  const usableMarketingKey = !!marketingKey && !marketingKey.revokedAt &&
    marketingAccess?.status === "approved" && !!marketingAccess.reviewedAt &&
    marketingKey.createdAt >= marketingAccess.reviewedAt && marketingPaid;
  res.json(ListApiCatalogResponse.parse(services.map((service) => {
    const request = latestByService.get(service.serviceKey);
    const approved = request?.status === "approved";
    const isMarketing = service.serviceKey === "marketing";
    return {
      ...service,
      accessStatus: request?.status ?? "none",
      requestId: request?.id ?? null,
      hasKey: isMarketing && usableMarketingKey,
      keyPrefix: isMarketing && usableMarketingKey ? marketingKey?.keyPrefix ?? null : null,
      createdAt: isMarketing && usableMarketingKey ? marketingKey?.createdAt ?? null : null,
      lastUsedAt: isMarketing && usableMarketingKey ? marketingKey?.lastUsedAt ?? null : null,
      docsPath: approved && isMarketing && marketingPaid ? "/api/external/marketing/docs" : null,
    };
  })));
});

router.get("/api-access/requests", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const rows = await db.select().from(apiAccessRequestsTable).where(
    staff.role === "district_manager"
      ? eq(apiAccessRequestsTable.organizationId, staff.organizationId)
      : and(
        eq(apiAccessRequestsTable.organizationId, staff.organizationId),
        eq(apiAccessRequestsTable.requestedByStaffId, staff.id),
      ),
  ).orderBy(desc(apiAccessRequestsTable.createdAt));
  const responses = await Promise.all(rows.map(requestResponse));
  res.json(ListApiAccessRequestsResponse.parse(responses));
});

router.post("/api-access/requests", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  const body = CreateApiAccessRequestBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Bitte wähle eine API und beschreibe den Verwendungszweck." }); return; }
  const service = services.find((item) => item.serviceKey === body.data.serviceKey);
  if (!service || service.availability !== "available") {
    res.status(409).json({ error: "Diese API ist noch in Vorbereitung und kann noch nicht beantragt werden." }); return;
  }
  const [latest] = await db.select().from(apiAccessRequestsTable).where(and(
    eq(apiAccessRequestsTable.organizationId, staff.organizationId),
    eq(apiAccessRequestsTable.serviceKey, body.data.serviceKey),
  )).orderBy(desc(apiAccessRequestsTable.createdAt)).limit(1);
  if (latest?.status === "pending" || latest?.status === "approved") {
    res.status(409).json({ error: latest.status === "pending" ? "Für diese API läuft bereits ein Antrag." : "Der API-Zugang ist bereits freigegeben." }); return;
  }
  const [row] = await db.insert(apiAccessRequestsTable).values({
    organizationId: staff.organizationId,
    serviceKey: body.data.serviceKey,
    requestedByStaffId: staff.id,
    reason: body.data.reason.trim(),
  }).returning();
  res.status(201).json(CreateApiAccessRequestResponse.parse(await requestResponse(row)));
});

router.patch("/api-access/requests/:id", async (req, res): Promise<void> => {
  const staff = await requireManager(req, res);
  if (!staff) return;
  if (staff.role !== "district_manager") { res.status(403).json({ error: "Nur die Bezirksleitung kann API-Anträge freigeben." }); return; }
  const params = ReviewApiAccessRequestParams.safeParse(req.params);
  const body = ReviewApiAccessRequestBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Ungültige Entscheidung." }); return; }
  const [existing] = await db.select().from(apiAccessRequestsTable).where(and(
    eq(apiAccessRequestsTable.id, params.data.id),
    eq(apiAccessRequestsTable.organizationId, staff.organizationId),
  )).limit(1);
  if (!existing) { res.status(404).json({ error: "Antrag nicht gefunden." }); return; }
  if (existing.status !== "pending") { res.status(409).json({ error: "Dieser Antrag wurde bereits bearbeitet." }); return; }
  const service = services.find((item) => item.serviceKey === existing.serviceKey);
  if (body.data.decision === "approve" && service?.availability !== "available") {
    res.status(409).json({ error: "Diese API ist noch nicht angebunden und kann nicht freigegeben werden." }); return;
  }
  const [updated] = await db.update(apiAccessRequestsTable).set({
    status: body.data.decision === "approve" ? "approved" : "rejected",
    reviewNote: body.data.reviewNote?.trim() || null,
    reviewedByStaffId: staff.id,
    reviewedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(apiAccessRequestsTable.id, existing.id)).returning();
  res.json(ReviewApiAccessRequestResponse.parse(await requestResponse(updated)));
});

export default router;
