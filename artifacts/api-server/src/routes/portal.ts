import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateCheckInBody,
  CreateCheckInResponse,
  CreateCourseBody,
  CreateCourseResponse,
  CreateMemberBody,
  CreateMemberResponse,
  CreateStudioBody,
  CreateStudioResponse,
  RequestStudioLogoUploadBody,
  RequestStudioLogoUploadResponse,
  CheckCourseImportDuplicatesBody,
  CheckCourseImportDuplicatesResponse,
  CompleteOnboardingBody,
  CompleteOnboardingResponse,
  GetDashboardQueryParams,
  GetDashboardResponse,
  GetDashboardAnalyticsQueryParams,
  GetDashboardAnalyticsResponse,
  GetMeResponse,
  ListCoursesQueryParams,
  ListCoursesResponse,
  ListMembersQueryParams,
  ListMembersResponse,
  ListStudiosResponse,
  UpdateMemberBody,
  UpdateMemberParams,
  UpdateMemberResponse,
  UpdateStudioBody,
  UpdateStudioParams,
  UpdateStudioResponse,
  UpdateStudioLogoBody,
  UpdateStudioLogoParams,
} from "@workspace/api-zod";
import {
  checkInsTable,
  coursesTable,
  db,
  membersTable,
  memberContractsTable,
  memberInvitationsTable,
  organizationsTable,
  pulseMessagesTable,
  roomClosuresTable,
  staffTable,
  studiosTable,
} from "@workspace/db";
import {
  canAccessStudio,
  canManageCourses,
  getAccessibleStudioIds,
  getClerkIdentity,
  getRequestUserId,
  getRequestStaffContext,
  getStaffContext,
  isOrganizationAdmin,
  isSystemAdmin,
  type StaffContext,
} from "../lib/fiudia-access";
import { isModuleEnabled } from "../lib/module-access";
import { closureIntersectsInterval, hasOverlappingLiveCourse } from "../lib/room-closures";
import { isTrainerAbsentForCourse, trainerLockKey } from "../lib/trainer-scheduling";
import { createStudioLogoUpload, getStudioLogoFile } from "../lib/studio-logos";

const router: IRouter = Router();
const CHECK_IN_MILESTONES = new Set([10, 25, 50, 100, 250, 500]);

function courseImportIdentityKey(course: { title: string; instructor: string; startsAt: Date | string }) {
  const normalize = (value: string) => value.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ").toLocaleLowerCase("de-DE");
  return JSON.stringify([
    normalize(course.title),
    normalize(course.instructor),
    new Date(course.startsAt).toISOString(),
  ]);
}

async function requireStaff(
  req: Request,
  res: Response,
): Promise<StaffContext | null> {
  const userId = getRequestUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Bitte melde dich an." });
    return null;
  }

  const staff = await getRequestStaffContext(req, db, userId);
  if (!staff) {
    res.status(403).json({ error: "Für dieses Konto ist noch kein Fiudia-Zugang hinterlegt." });
    return null;
  }
  return staff;
}

function serializeCourse(course: {
  id: number;
  title: string;
  instructor: string;
  studioId: number;
  studioName: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  enrolled: number;
  room: string;
  status: string;
  revision: number;
}) {
  return {
    ...course,
    startsAt: course.startsAt.toISOString(),
    endsAt: course.endsAt.toISOString(),
  };
}

function berlinDayRange(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  const year = part("year");
  const month = part("month");
  const day = part("day");

  const offsetAt = (utcGuess: number) => {
    const instant = new Date(utcGuess);
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .reduce<Record<string, number>>((values, item) => {
        if (item.type !== "literal") values[item.type] = Number(item.value);
        return values;
      }, {});

    return (
      Date.UTC(
        local.year,
        local.month - 1,
        local.day,
        local.hour,
        local.minute,
        local.second,
      ) - utcGuess
    );
  };

  const startGuess = Date.UTC(year, month - 1, day);
  const nextDayGuess = Date.UTC(year, month - 1, day + 1);
  return {
    start: new Date(startGuess - offsetAt(startGuess)),
    end: new Date(nextDayGuess - offsetAt(nextDayGuess)),
  };
}

function berlinRange(period: "day" | "month" | "quarter" | "year", now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = (key: string) => Number(parts.find((part) => part.type === key)?.value);
  const year = value("year");
  const month = value("month");
  const day = value("day");
  const current = new Date(Date.UTC(year, month - 1, 1, 12));
  if (period === "day") current.setUTCDate(day);
  if (period === "quarter") current.setUTCMonth(Math.floor((month - 1) / 3) * 3);
  if (period === "year") current.setUTCMonth(0);
  const previous = new Date(current);
  if (period === "day") previous.setUTCDate(previous.getUTCDate() - 1);
  if (period === "month") previous.setUTCMonth(previous.getUTCMonth() - 1);
  if (period === "quarter") previous.setUTCMonth(previous.getUTCMonth() - 3);
  if (period === "year") previous.setUTCFullYear(previous.getUTCFullYear() - 1);
  const next = new Date(current);
  if (period === "day") next.setUTCDate(next.getUTCDate() + 1);
  if (period === "month") next.setUTCMonth(next.getUTCMonth() + 1);
  if (period === "quarter") next.setUTCMonth(next.getUTCMonth() + 3);
  if (period === "year") next.setUTCFullYear(next.getUTCFullYear() + 1);
  return { start: berlinDayRange(current).start, end: berlinDayRange(next).start, previousStart: berlinDayRange(previous).start };
}

router.get("/me", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Bitte melde dich an." });
    return;
  }

  const identity = await getClerkIdentity(userId);
  const staff = await getRequestStaffContext(req, db, userId);
  const organizations = staff && isSystemAdmin(staff)
    ? await db.select({ id: organizationsTable.id, name: organizationsTable.name }).from(organizationsTable).orderBy(asc(organizationsTable.name))
    : [];
  res.json(
    GetMeResponse.parse({
      userId,
      userName: staff?.fullName ?? identity.fullName,
      email: staff?.email ?? identity.email,
      isOnboarded: !!staff,
      isSystemAdmin: staff?.isSystemAdmin ?? false,
      role: staff?.role ?? null,
      organizationId: staff?.organizationId ?? null,
      organizationName: staff?.organizationName ?? null,
      studioId: staff?.studioId ?? null,
      studioName: staff?.studioName ?? null,
      organizations,
    }),
  );
});

router.post("/onboarding", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Bitte melde dich an." });
    return;
  }

  const body = CompleteOnboardingBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  if (await getStaffContext(userId)) {
    res.status(409).json({ error: "Für dieses Konto besteht bereits ein Fiudia-Zugang." });
    return;
  }

  const identity = await getClerkIdentity(userId);
  const created = await db.transaction(async (tx) => {
    const [organization] = await tx
      .insert(organizationsTable)
      .values({ name: body.data.organizationName.trim() })
      .returning();
    const [studio] = await tx
      .insert(studiosTable)
      .values({
        organizationId: organization.id,
        name: body.data.studioName.trim(),
        city: body.data.city.trim(),
      })
      .returning();
    const [staff] = await tx
      .insert(staffTable)
      .values({
        clerkUserId: userId,
        organizationId: organization.id,
        studioId: studio.id,
        fullName: identity.fullName,
        email: identity.email,
        role: "district_manager",
      })
      .returning();
    return { organization, studio, staff };
  });

  res.status(201).json(
    CompleteOnboardingResponse.parse({
      userId,
      userName: created.staff.fullName,
      email: created.staff.email,
      isOnboarded: true,
      isSystemAdmin: false,
      role: created.staff.role,
      organizationId: created.organization.id,
      organizationName: created.organization.name,
      studioId: created.studio.id,
      studioName: created.studio.name,
      organizations: [],
    }),
  );
});

router.get("/studios", async (req, res): Promise<void> => {
  const staff = await requireStaff(req, res);
  if (!staff) return;
  const studioIds = await getAccessibleStudioIds(staff);
  if (!studioIds.length) {
    res.json(ListStudiosResponse.parse([]));
    return;
  }

  const studios = await db
    .select({
      id: studiosTable.id,
      name: studiosTable.name,
      city: studiosTable.city,
      openingTime: studiosTable.openingTime,
      closingTime: studiosTable.closingTime,
    })
    .from(studiosTable)
    .where(
      and(
        eq(studiosTable.organizationId, staff.organizationId),
        inArray(studiosTable.id, studioIds),
      ),
    )
    .orderBy(asc(studiosTable.name));
  res.json(ListStudiosResponse.parse(studios));
});

router.post("/studios", async (req, res): Promise<void> => {
  const staff = await requireStaff(req, res);
  if (!staff) return;
  if (!isOrganizationAdmin(staff)) {
    res.status(403).json({ error: "Nur Bezirksleitungen können Studios anlegen." });
    return;
  }
  const body = CreateStudioBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Bitte Studio-Name und Stadt mit jeweils 2 bis 120 Zeichen angeben." });
    return;
  }
  const name = body.data.name.trim();
  const city = body.data.city.trim();
  if (name.length < 2 || city.length < 2) {
    res.status(400).json({ error: "Bitte Studio-Name und Stadt mit jeweils 2 bis 120 Zeichen angeben." });
    return;
  }
  if ((body.data.openingTime ?? "06:00") >= (body.data.closingTime ?? "22:00")) {
    res.status(400).json({ error: "Die Schließzeit muss nach der Öffnungszeit liegen." });
    return;
  }
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fiudia-studio-create:${staff.organizationId}`}))`);
    const [existing] = await tx.select({ id: studiosTable.id }).from(studiosTable).where(and(
      eq(studiosTable.organizationId, staff.organizationId),
      sql<boolean>`lower(btrim(${studiosTable.name})) = lower(${name})`,
      sql<boolean>`lower(btrim(${studiosTable.city})) = lower(${city})`,
    )).limit(1);
    if (existing) return { error: "In dieser Stadt gibt es bereits ein Studio mit diesem Namen." as const };
    const [studio] = await tx.insert(studiosTable)
      .values({
        organizationId: staff.organizationId, name, city,
        openingTime: body.data.openingTime ?? "06:00",
        closingTime: body.data.closingTime ?? "22:00",
      })
      .returning({ id: studiosTable.id, name: studiosTable.name, city: studiosTable.city, openingTime: studiosTable.openingTime, closingTime: studiosTable.closingTime });
    return { studio };
  });
  if ("error" in result) {
    res.status(409).json({ error: result.error });
    return;
  }
  res.status(201).json(CreateStudioResponse.parse(result.studio));
});

router.patch("/studios/:id", async (req, res): Promise<void> => {
  const staff = await requireStaff(req, res);
  if (!staff) return;
  if (!isOrganizationAdmin(staff)) {
    res.status(403).json({ error: "Nur Bezirksleitungen können Studios bearbeiten." });
    return;
  }
  const params = UpdateStudioParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateStudioBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const name = body.data.name.trim();
  const city = body.data.city.trim();
  if (name.length < 2 || city.length < 2) {
    res.status(400).json({ error: "Bitte Studio-Name und Stadt mit jeweils 2 bis 120 Zeichen angeben." });
    return;
  }

  if ((body.data.openingTime ?? "06:00") >= (body.data.closingTime ?? "22:00")) {
    res.status(400).json({ error: "Die Schließzeit muss nach der Öffnungszeit liegen." });
    return;
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fiudia-studio-create:${staff.organizationId}`}))`);
    const [existingStudio] = await tx
      .select({ id: studiosTable.id })
      .from(studiosTable)
      .where(and(
        eq(studiosTable.id, params.data.id),
        eq(studiosTable.organizationId, staff.organizationId),
      ))
      .limit(1);
    if (!existingStudio) return { notFound: true as const };

    const [duplicate] = await tx.select({ id: studiosTable.id }).from(studiosTable).where(and(
      eq(studiosTable.organizationId, staff.organizationId),
      sql<boolean>`lower(btrim(${studiosTable.name})) = lower(${name})`,
      sql<boolean>`lower(btrim(${studiosTable.city})) = lower(${city})`,
      sql<boolean>`${studiosTable.id} <> ${params.data.id}`,
    )).limit(1);
    if (duplicate) return { duplicate: true as const };

    const [studio] = await tx.update(studiosTable)
      .set({
        name, city,
        openingTime: body.data.openingTime ?? "06:00",
        closingTime: body.data.closingTime ?? "22:00",
      })
      .where(and(
        eq(studiosTable.id, params.data.id),
        eq(studiosTable.organizationId, staff.organizationId),
      ))
      .returning({ id: studiosTable.id, name: studiosTable.name, city: studiosTable.city, openingTime: studiosTable.openingTime, closingTime: studiosTable.closingTime });
    return { studio };
  });
  if ("notFound" in result) {
    res.status(404).json({ error: "Studio nicht gefunden." });
    return;
  }
  if ("duplicate" in result) {
    res.status(409).json({ error: "In dieser Stadt gibt es bereits ein Studio mit diesem Namen." });
    return;
  }
  res.json(UpdateStudioResponse.parse(result.studio));
});

router.post("/studios/:id/logo/upload-url", async (req, res): Promise<void> => {
  const staff = await requireStaff(req, res);
  if (!staff) return;
  const params = UpdateStudioLogoParams.safeParse(req.params);
  const body = RequestStudioLogoUploadBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Bitte ein PNG-, JPEG- oder WebP-Logo bis 5 MB auswählen." });
    return;
  }
  if (staff.role === "studio_employee" || !(await canAccessStudio(staff, params.data.id))) {
    res.status(403).json({ error: "Du darfst dieses Studio nicht bearbeiten." });
    return;
  }
  try {
    const upload = await createStudioLogoUpload(params.data.id);
    res.json(RequestStudioLogoUploadResponse.parse(upload));
  } catch (error) {
    req.log.error({ err: error }, "Could not create studio logo upload URL");
    res.status(500).json({ error: "Der Logo-Upload konnte nicht vorbereitet werden." });
  }
});

router.patch("/studios/:id/logo", async (req, res): Promise<void> => {
  const staff = await requireStaff(req, res);
  if (!staff) return;
  const params = UpdateStudioLogoParams.safeParse(req.params);
  const body = UpdateStudioLogoBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Ungültige Logo-Daten." });
    return;
  }
  const { id } = params.data;
  if (staff.role === "studio_employee" || !(await canAccessStudio(staff, id))) {
    res.status(403).json({ error: "Du darfst dieses Studio nicht bearbeiten." });
    return;
  }
  if (!body.data.objectPath.startsWith(`/objects/studio-logos/${id}/`)) {
    res.status(400).json({ error: "Der Upload gehört nicht zu diesem Studio." });
    return;
  }
  const file = await getStudioLogoFile(body.data.objectPath);
  if (!file) {
    res.status(400).json({ error: "Das hochgeladene Logo wurde nicht gefunden." });
    return;
  }
  const [metadata] = await file.getMetadata();
  const actualSize = Number(metadata.size);
  if (!["image/png", "image/jpeg", "image/webp"].includes(String(metadata.contentType)) ||
      !Number.isFinite(actualSize) || actualSize < 1 || actualSize > 5 * 1024 * 1024) {
    res.status(400).json({ error: "Bitte ein PNG-, JPEG- oder WebP-Logo bis 5 MB hochladen." });
    return;
  }
  await db.update(studiosTable).set({ logoPath: body.data.objectPath })
    .where(and(eq(studiosTable.id, id), eq(studiosTable.organizationId, staff.organizationId)));
  res.json({ success: true });
});

router.get("/dashboard/analytics", async (req, res): Promise<void> => {
  const staff = await requireStaff(req, res);
  if (!staff) return;
  if (staff.role === "studio_employee") {
    res.status(403).json({ error: "Dashboard-Analysen sind nur für Studioleitungen verfügbar." });
    return;
  }
  if (!(await isModuleEnabled(staff.organizationId, "members"))) {
    res.status(403).json({ error: "Das Mitglieder-Modul ist für diese Organisation nicht aktiviert." });
    return;
  }
  const query = GetDashboardAnalyticsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Ungültiger Zeitraum oder Studiofilter." });
    return;
  }
  const accessible = await getAccessibleStudioIds(staff);
  const studioId = query.data.studioId ?? staff.studioId ?? accessible[0];
  if (!studioId || !accessible.includes(studioId) || !(await canAccessStudio(staff, studioId))) {
    res.status(403).json({ error: "Kein Zugriff auf dieses Studio." });
    return;
  }
  const [studio] = await db.select({
    openingTime: studiosTable.openingTime,
    closingTime: studiosTable.closingTime,
  }).from(studiosTable).where(eq(studiosTable.id, studioId)).limit(1);
  if (!studio) { res.status(404).json({ error: "Studio nicht gefunden." }); return; }

  const { start, end, previousStart } = berlinRange(query.data.period);
  const hourExpr = sql<number>`EXTRACT(HOUR FROM ${checkInsTable.checkedInAt} AT TIME ZONE 'Europe/Berlin')::int`;
  const hourlyRows = await db.select({ hour: hourExpr, count: count() }).from(checkInsTable)
    .where(and(eq(checkInsTable.studioId, studioId), gte(checkInsTable.checkedInAt, start), lt(checkInsTable.checkedInAt, end)))
    .groupBy(hourExpr);
  const openingHour = Number(studio.openingTime.slice(0, 2));
  const closingHour = Number(studio.closingTime.slice(0, 2));
  const currentHour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23",
  }).format(new Date()));
  const checkInsByHour = Array.from({ length: Math.max(1, closingHour - openingHour) }, (_, i) => {
    const hour = openingHour + i;
    return { hour, count: Number(hourlyRows.find((row) => Number(row.hour) === hour)?.count ?? 0) };
  });

  const unit = query.data.period === "day" ? "hour" : query.data.period === "year" ? "month" : query.data.period === "quarter" ? "week" : "day";
  const format = query.data.period === "day" ? "HH24:00" : query.data.period === "month" ? "DD" : query.data.period === "quarter" ? "IW" : "MM";
  const bucketExpr = sql`date_trunc(${sql.raw(`'${unit}'`)}, ${memberContractsTable.signedAt} AT TIME ZONE 'Europe/Berlin')`;
  const labelExpr = sql<string>`to_char(${bucketExpr}, ${sql.raw(`'${format}'`)})`;
  const contractBucketsIn = (from: Date, to: Date) => db.select({ label: labelExpr, count: count() })
    .from(memberContractsTable).innerJoin(membersTable, eq(memberContractsTable.memberId, membersTable.id))
    .where(and(
      eq(membersTable.studioId, studioId),
      eq(memberContractsTable.status, "signed"),
      gte(memberContractsTable.signedAt, from),
      lt(memberContractsTable.signedAt, to),
    )).groupBy(bucketExpr).orderBy(bucketExpr);
  const [currentBuckets, previousBuckets, genderRows] = await Promise.all([
    contractBucketsIn(start, end),
    contractBucketsIn(previousStart, start),
    db.select({ gender: membersTable.gender, count: count() }).from(membersTable)
      .where(eq(membersTable.studioId, studioId)).groupBy(membersTable.gender),
  ]);
  const signedContracts = currentBuckets.reduce((sum, row) => sum + Number(row.count), 0);
  const previousContracts = previousBuckets.reduce((sum, row) => sum + Number(row.count), 0);
  const genderCounts = (["male", "female", "diverse"] as const).map((gender) => ({
    gender, count: Number(genderRows.find((row) => row.gender === gender)?.count ?? 0),
  }));
  res.json(GetDashboardAnalyticsResponse.parse({
    period: query.data.period,
    openingTime: studio.openingTime,
    closingTime: studio.closingTime,
    currentHour,
    checkInsByHour,
    signedContracts,
    previousContracts,
    contractChangePercent: previousContracts ? Math.round((signedContracts - previousContracts) / previousContracts * 100) : null,
    contractBuckets: [...new Set([...currentBuckets, ...previousBuckets].map((row) => row.label))].sort().map((label) => ({
      label,
      current: Number(currentBuckets.find((item) => item.label === label)?.count ?? 0),
      previous: Number(previousBuckets.find((item) => item.label === label)?.count ?? 0),
    })),
    genderCounts,
  }));
});

router.get("/dashboard", async (req, res): Promise<void> => {
  const staff = await requireStaff(req, res);
  if (!staff) return;
  const query = GetDashboardQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (query.data.studioId !== undefined && !(await canAccessStudio(staff, query.data.studioId))) {
    res.status(403).json({ error: "Kein Zugriff auf dieses Studio." });
    return;
  }
  const accessibleStudioIds = await getAccessibleStudioIds(staff);
  const studioIds = query.data.studioId === undefined
    ? accessibleStudioIds
    : accessibleStudioIds.filter((id) => id === query.data.studioId);
  const [selectedStudio] = query.data.studioId === undefined ? [] : await db
    .select({ name: studiosTable.name })
    .from(studiosTable)
    .where(and(
      eq(studiosTable.id, query.data.studioId),
      eq(studiosTable.organizationId, staff.organizationId),
    ))
    .limit(1);
  const { start, end } = berlinDayRange();
  const [membersEnabled, coursesEnabled] = await Promise.all([
    isModuleEnabled(staff.organizationId, "members"),
    isModuleEnabled(staff.organizationId, "courses"),
  ]);

  const [activeMembers] = membersEnabled && studioIds.length
    ? await db
        .select({ total: count() })
        .from(membersTable)
        .where(
          and(
            inArray(membersTable.studioId, studioIds),
            eq(membersTable.status, "active"),
          ),
        )
    : [{ total: 0 }];
  const todayCheckIns = membersEnabled && studioIds.length
    ? await db
        .select({ id: checkInsTable.id })
        .from(checkInsTable)
        .where(
          and(
            inArray(checkInsTable.studioId, studioIds),
            gte(checkInsTable.checkedInAt, start),
            lt(checkInsTable.checkedInAt, end),
          ),
        )
    : [];
  const courseRows = coursesEnabled && studioIds.length
    ? await db
        .select({
          id: coursesTable.id,
          title: coursesTable.title,
          instructor: coursesTable.instructor,
          studioId: coursesTable.studioId,
          studioName: studiosTable.name,
          startsAt: coursesTable.startsAt,
          endsAt: coursesTable.endsAt,
          capacity: coursesTable.capacity,
          enrolled: coursesTable.enrolled,
          room: coursesTable.room,
          status: coursesTable.status,
          revision: coursesTable.revision,
        })
        .from(coursesTable)
        .innerJoin(studiosTable, eq(coursesTable.studioId, studiosTable.id))
        .where(
          and(
            inArray(coursesTable.studioId, studioIds),
            gte(coursesTable.startsAt, start),
            lt(coursesTable.startsAt, end),
            inArray(coursesTable.status, ["scheduled", "full"]),
          ),
        )
        .orderBy(asc(coursesTable.startsAt))
    : [];
  const recentCheckIns = membersEnabled && studioIds.length
    ? await db
        .select({
          id: checkInsTable.id,
          memberName: membersTable.fullName,
          checkedInAt: checkInsTable.checkedInAt,
        })
        .from(checkInsTable)
        .innerJoin(membersTable, eq(checkInsTable.memberId, membersTable.id))
        .where(inArray(checkInsTable.studioId, studioIds))
        .orderBy(desc(checkInsTable.checkedInAt))
        .limit(5)
    : [];

  const courseCapacity = courseRows.reduce((total, course) => total + course.capacity, 0);
  const enrolled = courseRows.reduce((total, course) => total + course.enrolled, 0);
  const utilization =
    courseCapacity > 0 ? Math.round((enrolled / courseCapacity) * 100) : 0;
  const activities = recentCheckIns.map((checkIn) => ({
    id: checkIn.id,
    title: "Mitglied eingecheckt",
    description:
      staff.role === "studio_employee"
        ? "Ein Check-in wurde erfasst."
        : checkIn.memberName,
    happenedAt: checkIn.checkedInAt.toISOString(),
    category: "check_in" as const,
  }));
  const nextCourses = coursesEnabled && studioIds.length
    ? await db
        .select({
          id: coursesTable.id,
          title: coursesTable.title,
          instructor: coursesTable.instructor,
          studioId: coursesTable.studioId,
          studioName: studiosTable.name,
          startsAt: coursesTable.startsAt,
          endsAt: coursesTable.endsAt,
          capacity: coursesTable.capacity,
          enrolled: coursesTable.enrolled,
          room: coursesTable.room,
          status: coursesTable.status,
          revision: coursesTable.revision,
        })
        .from(coursesTable)
        .innerJoin(studiosTable, eq(coursesTable.studioId, studiosTable.id))
        .where(
          and(
            inArray(coursesTable.studioId, studioIds),
            gte(coursesTable.startsAt, start),
            inArray(coursesTable.status, ["scheduled", "full"]),
          ),
        )
        .orderBy(asc(coursesTable.startsAt))
        .limit(40)
    : [];

  res.json(
    GetDashboardResponse.parse({
      role: staff.role,
      userName: staff.fullName,
      studioName:
        selectedStudio?.name ?? (staff.role === "district_manager"
          ? staff.organizationName
          : staff.studioName ?? staff.organizationName),
      metrics: [
        ...(membersEnabled
          ? [
              {
                label: "Aktive Mitglieder",
                value: String(activeMembers.total),
                delta: "im Bestand",
                tone: "neutral",
              },
            {
              label: "Check-ins heute",
              value: String(todayCheckIns.length),
              delta: "live erfasst",
              tone: "positive",
            },
          ]
          : []),
        ...(coursesEnabled
          ? [
              {
                label: "Kursauslastung",
                value: `${utilization} %`,
                delta: `${courseRows.length} Kurse heute`,
                tone: utilization >= 90 ? "warning" : "positive",
              },
          ]
          : []),
      ],
      activities,
      courses: nextCourses.map(serializeCourse),
    }),
  );
});

router.get("/members", async (req, res): Promise<void> => {
  const staff = await requireStaff(req, res);
  if (!staff) return;
  const query = ListMembersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (
    query.data.studioId !== undefined &&
    !(await canAccessStudio(staff, query.data.studioId))
  ) {
    res.status(403).json({ error: "Kein Zugriff auf dieses Studio." });
    return;
  }
  const studioIds = await getAccessibleStudioIds(staff);
  if (studioIds.length === 0) {
    res.json([]);
    return;
  }

  const conditions: SQL[] = [inArray(membersTable.studioId, studioIds)];
  if (query.data.studioId !== undefined) {
    conditions.push(eq(membersTable.studioId, query.data.studioId));
  }
  if (query.data.status) {
    conditions.push(eq(membersTable.status, query.data.status));
  }
  if (query.data.search?.trim()) {
    const term = `%${query.data.search.trim()}%`;
    const searchFilter = or(
      ilike(membersTable.fullName, term),
      ...(staff.role === "studio_employee"
        ? []
        : [ilike(membersTable.email, term)]),
    );
    if (searchFilter) conditions.push(searchFilter);
  }

  const rows = await db
    .select({
      id: membersTable.id,
      fullName: membersTable.fullName,
      email: membersTable.email,
      phone: membersTable.phone,
      membershipType: membersTable.membershipType,
      gender: membersTable.gender,
      marketingConsent: membersTable.marketingConsent,
      billingInterval: membersTable.billingInterval,
      status: membersTable.status,
      birthDate: membersTable.birthDate,
      address: membersTable.address,
      contractStart: membersTable.contractStart,
      contractDurationMonths: membersTable.contractDurationMonths,
      studioId: membersTable.studioId,
      studioName: studiosTable.name,
      joinedAt: membersTable.joinedAt,
    })
    .from(membersTable)
    .innerJoin(studiosTable, eq(membersTable.studioId, studiosTable.id))
    .where(and(...conditions))
    .orderBy(desc(membersTable.joinedAt))
    .limit(200);

  const memberIds = rows.map((row) => row.id);
  const invitations = memberIds.length && staff.role !== "studio_employee"
    ? await db.select({
      memberId: memberInvitationsTable.memberId,
      status: memberInvitationsTable.status,
      expiresAt: memberInvitationsTable.expiresAt,
      email: memberInvitationsTable.email,
      emailStatus: memberInvitationsTable.emailStatus,
    }).from(memberInvitationsTable)
      .where(inArray(memberInvitationsTable.memberId, memberIds))
      .orderBy(desc(memberInvitationsTable.createdAt))
    : [];
  const latestInvitation = new Map<number, typeof invitations[number]>();
  for (const invite of invitations) if (!latestInvitation.has(invite.memberId)) latestInvitation.set(invite.memberId, invite);
  const recentCheckIns = memberIds.length
    ? await db
        .select({
          memberId: checkInsTable.memberId,
          checkedInAt: checkInsTable.checkedInAt,
        })
        .from(checkInsTable)
        .where(inArray(checkInsTable.memberId, memberIds))
        .orderBy(desc(checkInsTable.checkedInAt))
    : [];
  const latestCheckIn = new Map<number, Date>();
  for (const checkIn of recentCheckIns) {
    if (!latestCheckIn.has(checkIn.memberId)) {
      latestCheckIn.set(checkIn.memberId, checkIn.checkedInAt);
    }
  }

  res.json(
    ListMembersResponse.parse(
      rows.map((member) => ({
        ...member,
        invitationStatus: staff.role === "studio_employee" ? null : (() => {
          const invitation = latestInvitation.get(member.id);
          if (!invitation) return null;
          if (invitation.email !== member.email?.trim().toLowerCase()) return "revoked";
          return invitation.status === "pending" && invitation.expiresAt <= new Date()
            ? "expired" : invitation.status;
        })(),
        invitationEmailStatus: staff.role === "studio_employee"
          ? null : latestInvitation.get(member.id)?.emailStatus ?? null,
        ...(staff.role === "studio_employee"
          ? { email: null, phone: null, gender: null, marketingConsent: false, birthDate: null, address: null, contractStart: null, contractDurationMonths: null }
          : {}),
        marketingConsent: staff.role !== "studio_employee" && member.marketingConsent === 1,
        joinedAt: member.joinedAt.toISOString(),
        lastCheckIn: latestCheckIn.get(member.id)?.toISOString() ?? null,
      })),
    ),
  );
});

router.post("/members", async (req, res): Promise<void> => {
  const staff = await requireStaff(req, res);
  if (!staff) return;
  if (staff.role === "studio_employee") {
    res.status(403).json({ error: "Deine Rolle darf keine Mitglieder verwalten." });
    return;
  }
  const body = CreateMemberBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!(await canAccessStudio(staff, body.data.studioId))) {
    res.status(403).json({ error: "Kein Zugriff auf dieses Studio." });
    return;
  }

  const [member] = await db
    .insert(membersTable)
    .values({
      ...body.data,
      fullName: body.data.fullName.trim(),
      email: body.data.email.trim().toLowerCase(),
      phone: body.data.phone?.trim() || null,
      membershipType: body.data.membershipType.trim(),
      marketingConsent: body.data.marketingConsent ? 1 : 0,
      marketingConsentAt: body.data.marketingConsent ? new Date() : null,
      status: body.data.status ?? "active",
      birthDate: body.data.birthDate || null,
      address: body.data.address?.trim() || null,
      contractStart: body.data.contractStart || null,
      contractDurationMonths: body.data.contractDurationMonths ?? null,
    })
    .returning();
  const [studio] = await db
    .select({ name: studiosTable.name })
    .from(studiosTable)
    .where(eq(studiosTable.id, member.studioId))
    .limit(1);

  res.status(201).json(
    CreateMemberResponse.parse({
      ...member,
      marketingConsent: member.marketingConsent === 1,
      contactConsent: member.contactConsent === 1,
      studioName: studio.name,
      joinedAt: member.joinedAt.toISOString(),
      lastCheckIn: null,
    }),
  );
});

router.patch("/members/:id", async (req, res): Promise<void> => {
  const staff = await requireStaff(req, res);
  if (!staff) return;
  const params = UpdateMemberParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateMemberBody.safeParse(req.body);
  if (!body.success || Object.keys(body.data ?? {}).length === 0) {
    res.status(400).json({ error: body.success ? "Keine Änderungen angegeben." : body.error.message });
    return;
  }
  if (staff.role === "studio_employee") {
    const editableFields = new Set([
      "fullName", "email", "phone", "membershipType", "billingInterval",
      "birthDate", "address", "contractStart", "contractDurationMonths",
      "restPeriodStart", "restPeriodEnd", "status",
    ]);
    if (Object.keys(body.data).some((field) => !editableFields.has(field))) {
      res.status(403).json({ error: "Deine Rolle darf nur Mitglieds- und Vertragsdaten bearbeiten." });
      return;
    }
  }
  const [existing] = await db
    .select()
    .from(membersTable)
    .where(eq(membersTable.id, params.data.id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Mitglied nicht gefunden." });
    return;
  }
  if (!(await canAccessStudio(staff, existing.studioId))) {
    res.status(403).json({ error: "Kein Zugriff auf dieses Mitglied." });
    return;
  }

  const { marketingConsent, ...memberChanges } = body.data;
  const values = {
    ...memberChanges,
    ...(body.data.email !== undefined
      ? { email: body.data.email.trim().toLowerCase() }
      : {}),
    ...(body.data.fullName !== undefined
      ? { fullName: body.data.fullName.trim() }
      : {}),
    ...(body.data.membershipType !== undefined
      ? { membershipType: body.data.membershipType.trim() }
      : {}),
    ...(body.data.phone !== undefined
      ? { phone: body.data.phone?.trim() || null }
      : {}),
    ...(body.data.birthDate !== undefined ? { birthDate: body.data.birthDate || null } : {}),
    ...(body.data.address !== undefined ? { address: body.data.address?.trim() || null } : {}),
    ...(body.data.contractStart !== undefined ? { contractStart: body.data.contractStart || null } : {}),
    ...(body.data.contractDurationMonths !== undefined ? { contractDurationMonths: body.data.contractDurationMonths } : {}),
    ...(marketingConsent !== undefined ? {
      marketingConsent: marketingConsent ? 1 : 0,
      marketingConsentAt: marketingConsent ? new Date() : null,
    } : {}),
  };
  const [updated] = await db
    .update(membersTable)
    .set(values)
    .where(eq(membersTable.id, params.data.id))
    .returning();
  const [studio] = await db
    .select({ name: studiosTable.name })
    .from(studiosTable)
    .where(eq(studiosTable.id, updated.studioId))
    .limit(1);
  const [latest] = await db
    .select({ checkedInAt: checkInsTable.checkedInAt })
    .from(checkInsTable)
    .where(eq(checkInsTable.memberId, updated.id))
    .orderBy(desc(checkInsTable.checkedInAt))
    .limit(1);

  res.json(
    UpdateMemberResponse.parse({
      ...updated,
      marketingConsent: updated.marketingConsent === 1,
      contactConsent: updated.contactConsent === 1,
      studioName: studio.name,
      joinedAt: updated.joinedAt.toISOString(),
      lastCheckIn: latest?.checkedInAt.toISOString() ?? null,
    }),
  );
});

router.get("/courses", async (req, res): Promise<void> => {
  const staff = await requireStaff(req, res);
  if (!staff) return;
  const query = ListCoursesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (query.data.studioId !== undefined && !(await canAccessStudio(staff, query.data.studioId))) {
    res.status(403).json({ error: "Kein Zugriff auf dieses Studio." });
    return;
  }
  const accessibleStudioIds = await getAccessibleStudioIds(staff);
  const studioIds = query.data.studioId === undefined
    ? accessibleStudioIds
    : accessibleStudioIds.filter((id) => id === query.data.studioId);
  const rows = studioIds.length
    ? await db
        .select({
          id: coursesTable.id,
          title: coursesTable.title,
          instructor: coursesTable.instructor,
          studioId: coursesTable.studioId,
          studioName: studiosTable.name,
          startsAt: coursesTable.startsAt,
          endsAt: coursesTable.endsAt,
          capacity: coursesTable.capacity,
          enrolled: coursesTable.enrolled,
          room: coursesTable.room,
          status: coursesTable.status,
          revision: coursesTable.revision,
        })
        .from(coursesTable)
        .innerJoin(studiosTable, eq(coursesTable.studioId, studiosTable.id))
        .where(
          and(
            inArray(coursesTable.studioId, studioIds),
            gte(coursesTable.startsAt, new Date()),
          ),
        )
        .orderBy(asc(coursesTable.startsAt))
        .limit(100)
    : [];

  res.json(ListCoursesResponse.parse(rows.map(serializeCourse)));
});

router.post("/courses/import-duplicates", async (req, res): Promise<void> => {
  const staff = await requireStaff(req, res);
  if (!staff) return;
  if (!canManageCourses(staff)) {
    res.status(403).json({ error: "Nur Studio- und Bezirksleitungen können Kursimporte prüfen." });
    return;
  }
  const body = CheckCourseImportDuplicatesBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!(await canAccessStudio(staff, body.data.studioId))) {
    res.status(403).json({ error: "Kein Zugriff auf dieses Studio." });
    return;
  }

  const rows = body.data.rows;
  const startTimes = [...new Set(rows.map((row) => new Date(row.startsAt).toISOString()))]
    .map((value) => new Date(value));
  const existing = await db.select({
    title: coursesTable.title,
    instructor: coursesTable.instructor,
    startsAt: coursesTable.startsAt,
  }).from(coursesTable).where(and(
    eq(coursesTable.studioId, body.data.studioId),
    inArray(coursesTable.status, ["scheduled", "full"]),
    inArray(coursesTable.startsAt, startTimes),
  ));

  const seen = new Set(existing.map(courseImportIdentityKey));
  const duplicateLines: number[] = [];
  for (const row of rows) {
    const key = courseImportIdentityKey(row);
    if (seen.has(key)) duplicateLines.push(row.line);
    else seen.add(key);
  }
  res.json(CheckCourseImportDuplicatesResponse.parse({ duplicateLines }));
});

router.post("/courses", async (req, res): Promise<void> => {
  const staff = await requireStaff(req, res);
  if (!staff) return;
  if (!canManageCourses(staff)) {
    res.status(403).json({ error: "Nur Studio- und Bezirksleitungen können Kurse anlegen." });
    return;
  }
  const body = CreateCourseBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!(await canAccessStudio(staff, body.data.studioId))) {
    res.status(403).json({ error: "Kein Zugriff auf dieses Studio." });
    return;
  }
  const startsAt = new Date(body.data.startsAt);
  const endsAt = new Date(body.data.endsAt);
  if (
    Number.isNaN(startsAt.getTime()) ||
    Number.isNaN(endsAt.getTime()) ||
    endsAt <= startsAt
  ) {
    res.status(400).json({ error: "Das Kursende muss nach dem Kursstart liegen." });
    return;
  }
  const instructor = body.data.instructor.trim();
  if (instructor.length < 2) {
    res.status(400).json({ error: "Bitte eine gültige Trainerperson angeben." });
    return;
  }

  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${trainerLockKey(body.data.studioId, instructor)}))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fiudia-room:${body.data.studioId}:${body.data.room}`}))`);
    if (await isTrainerAbsentForCourse(body.data.studioId, instructor, startsAt, endsAt, tx)) {
      return { error: "Diese Trainerperson ist am Kurstag abwesend. Bitte eine andere Kursleitung wählen." as const };
    }
    const closures = await tx.select({
      fromDate: roomClosuresTable.fromDate,
      toDate: roomClosuresTable.toDate,
    }).from(roomClosuresTable).where(and(
      eq(roomClosuresTable.studioId, body.data.studioId),
      eq(roomClosuresTable.roomName, body.data.room),
    ));
    if (closures.some((closure) => closureIntersectsInterval(closure.fromDate, closure.toDate, startsAt, endsAt))) {
      return { error: "Dieser Raum ist während des Kursintervalls geschlossen." as const };
    }
    if (await hasOverlappingLiveCourse(body.data.studioId, body.data.room, startsAt, endsAt, tx)) {
      return { error: "In diesem Raum liegt bereits ein überlappender Kurs." as const };
    }
    const [createdCourse] = await tx
      .insert(coursesTable)
      .values({ ...body.data, instructor, startsAt, endsAt })
      .returning();
    const [courseStudio] = await tx
      .select({
        name: studiosTable.name,
        organizationId: studiosTable.organizationId,
      })
      .from(studiosTable)
      .where(eq(studiosTable.id, createdCourse.studioId))
      .limit(1);
    if (await isModuleEnabled(courseStudio.organizationId, "pulse", tx)) {
      await tx.insert(pulseMessagesTable).values({
        organizationId: courseStudio.organizationId,
        studioId: createdCourse.studioId,
        authorStaffId: staff.id,
        title: "Neuer Kurs geplant",
        body: "Ein neuer Kurs wurde im Studio geplant.",
        priority: "info",
        audience: "all",
      });
    }
    return { course: createdCourse, studio: courseStudio };
  });
  if ("error" in created) {
    res.status(409).json({ error: created.error });
    return;
  }
  const { course, studio } = created;
  res.status(201).json(
    CreateCourseResponse.parse(serializeCourse({ ...course, studioName: studio.name })),
  );
});

router.post("/check-ins", async (req, res): Promise<void> => {
  const staff = await requireStaff(req, res);
  if (!staff) return;
  const body = CreateCheckInBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!(await canAccessStudio(staff, body.data.studioId))) {
    res.status(403).json({ error: "Kein Zugriff auf dieses Studio." });
    return;
  }
  const [member] = await db
    .select({ id: membersTable.id, fullName: membersTable.fullName })
    .from(membersTable)
    .where(
      and(
        eq(membersTable.id, body.data.memberId),
        eq(membersTable.studioId, body.data.studioId),
        eq(membersTable.status, "active"),
      ),
    )
    .limit(1);
  if (!member) {
    res.status(404).json({ error: "Aktives Mitglied nicht gefunden." });
    return;
  }

  const checkIn = await db.transaction(async (tx) => {
    // Serializing per staff record prevents concurrent check-ins from skipping milestones.
    await tx
      .select({ id: staffTable.id })
      .from(staffTable)
      .where(eq(staffTable.id, staff.id))
      .for("update");
    const [createdCheckIn] = await tx
      .insert(checkInsTable)
      .values({
        memberId: member.id,
        studioId: body.data.studioId,
        checkedInByStaffId: staff.id,
      })
      .returning();
    const [staffCheckInCount] = await tx
      .select({ total: count() })
      .from(checkInsTable)
      .where(
        and(
          eq(checkInsTable.checkedInByStaffId, staff.id),
          eq(checkInsTable.studioId, createdCheckIn.studioId),
        ),
      );
    if (
      CHECK_IN_MILESTONES.has(staffCheckInCount.total) &&
      (await isModuleEnabled(staff.organizationId, "pulse", tx))
    ) {
      await tx.insert(pulseMessagesTable).values({
        organizationId: staff.organizationId,
        studioId: createdCheckIn.studioId,
        authorStaffId: staff.id,
        title: "Check-in-Meilenstein erreicht",
        body: `Ein Teammitglied hat ${staffCheckInCount.total} Check-ins erfasst.`,
        priority: "info",
        audience: "all",
      });
    }
    return createdCheckIn;
  });
  res.status(201).json(
    CreateCheckInResponse.parse({
      id: checkIn.id,
      memberId: member.id,
      memberName: member.fullName,
      studioId: checkIn.studioId,
      checkedInAt: checkIn.checkedInAt.toISOString(),
    }),
  );
});

export default router;