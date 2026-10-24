import { and, asc, count, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  BookMemberCourseParams, BookMemberCourseResponse,
  CancelMemberCourseParams, CancelMemberCourseResponse,
  ClaimMembershipBody, ClaimMembershipResponse,
  GetMemberHomeResponse, GetMemberCourseParams, GetMemberCourseResponse, GetMemberNotificationUnreadCountResponse, ListMemberCheckInsResponse, ListMemberCoursesQueryParams, ListMemberCoursesResponse,
  ListMemberNotificationsQueryParams, ListMemberNotificationsResponse, MarkMemberNotificationReadParams,
  MarkMemberNotificationReadResponse,
  RegisterMemberPushSubscriptionBody, RegisterMemberPushSubscriptionResponse,
  GetMemberBillingResponse, CreateMemberBillingCheckoutResponse,
  UpdateOwnMemberProfileBody,
  UpdateMemberNotificationSettingsBody, UpdateMemberNotificationSettingsResponse,
  UnregisterMemberPushSubscriptionParams, UnregisterMemberPushSubscriptionResponse,
} from "@workspace/api-zod";
import {
  checkInsTable, courseBookingsTable, coursesTable, db, memberNotificationsTable,
  memberPushSubscriptionsTable, membersTable, studiosTable, waitlistEmailDeliveriesTable,
  membershipPlansTable,
} from "@workspace/db";
import { BookingError, bookCourse, cancelCourseBooking } from "../lib/course-bookings";
import { getClerkIdentity, getRequestUserId } from "../lib/fiudia-access";
import { linkMembership, MemberLinkError } from "../lib/member-link";
import { isModuleEnabled } from "../lib/module-access";
import { getStripeClient } from "../lib/stripe-client";

const router: IRouter = Router();

export async function linkedMember(userId: string) {
  const [member] = await db.select({
    id: membersTable.id,
    fullName: membersTable.fullName,
    email: membersTable.email,
    phone: membersTable.phone,
    membershipType: membersTable.membershipType,
    billingInterval: membersTable.billingInterval,
    status: membersTable.status,
    birthDate: membersTable.birthDate,
    address: membersTable.address,
    contractStart: membersTable.contractStart,
    contractDurationMonths: membersTable.contractDurationMonths,
    restPeriodStart: membersTable.restPeriodStart,
    restPeriodEnd: membersTable.restPeriodEnd,
    stripeCustomerId: membersTable.stripeCustomerId,
    stripeSubscriptionId: membersTable.stripeSubscriptionId,
    stripeCheckoutSessionId: membersTable.stripeCheckoutSessionId,
    billingStatus: membersTable.billingStatus,
    waitlistEmailEnabled: membersTable.waitlistEmailEnabled,
    studioId: studiosTable.id,
    studioName: studiosTable.name,
    organizationId: studiosTable.organizationId,
    joinedAt: membersTable.joinedAt,
  }).from(membersTable)
    .innerJoin(studiosTable, eq(membersTable.studioId, studiosTable.id))
    .where(eq(membersTable.clerkUserId, userId)).limit(1);
  return member ?? null;
}

type LinkedMember = NonNullable<Awaited<ReturnType<typeof linkedMember>>>;

async function memberCourses(member: LinkedMember, requestedId?: number, detailOnly = false) {
  if (!(await isModuleEnabled(member.organizationId, "courses"))) return [];
  const upcoming = await db.select({
    id: coursesTable.id,
    title: coursesTable.title,
    instructor: coursesTable.instructor,
    startsAt: coursesTable.startsAt,
    endsAt: coursesTable.endsAt,
    capacity: coursesTable.capacity,
    enrolled: coursesTable.enrolled,
    room: coursesTable.room,
    status: coursesTable.status,
  }).from(coursesTable)
    .where(and(
      eq(coursesTable.studioId, member.studioId),
      detailOnly ? eq(coursesTable.id, requestedId!) : undefined,
      gte(coursesTable.startsAt, new Date()),
      inArray(coursesTable.status, ["scheduled", "full"]),
    )).orderBy(asc(coursesTable.startsAt)).limit(60);
  const courses = [...upcoming];
  if (requestedId !== undefined && !courses.some(course => course.id === requestedId)) {
    // Older courses are exposed only through a notification belonging to this
    // member, and only while the course still belongs to their studio.
    const [notice] = await db.select({ id: memberNotificationsTable.id })
      .from(memberNotificationsTable)
      .where(and(
        eq(memberNotificationsTable.memberId, member.id),
        eq(memberNotificationsTable.courseId, requestedId),
      )).limit(1);
    if (notice) {
      const [target] = await db.select({
        id: coursesTable.id,
        title: coursesTable.title,
        instructor: coursesTable.instructor,
        startsAt: coursesTable.startsAt,
        endsAt: coursesTable.endsAt,
        capacity: coursesTable.capacity,
        enrolled: coursesTable.enrolled,
        room: coursesTable.room,
        status: coursesTable.status,
      }).from(coursesTable)
        .where(and(eq(coursesTable.id, requestedId), eq(coursesTable.studioId, member.studioId)))
        .limit(1);
      if (target) courses.push(target);
    }
  }
  if (!courses.length) return [];
  const ids = courses.map((course) => course.id);
  const allBookings = await db.select({
    id: courseBookingsTable.id, courseId: courseBookingsTable.courseId,
    memberId: courseBookingsTable.memberId, status: courseBookingsTable.status,
  }).from(courseBookingsTable)
    .where(and(inArray(courseBookingsTable.courseId, ids),
      inArray(courseBookingsTable.status, ["confirmed", "waitlisted"])))
    .orderBy(asc(courseBookingsTable.createdAt), asc(courseBookingsTable.id));
  return courses.map((course) => {
    const own = allBookings.find((booking) =>
      booking.courseId === course.id && booking.memberId === member.id);
    const queue = allBookings.filter((booking) =>
      booking.courseId === course.id && booking.status === "waitlisted");
    return {
      ...course, studioName: member.studioName,
      bookingStatus: own?.status === "confirmed" || own?.status === "waitlisted"
        ? own.status : null,
      waitlistPosition: own?.status === "waitlisted"
        ? queue.findIndex((booking) => booking.id === own.id) + 1 : null,
    };
  });
}

export async function memberHome(member: LinkedMember | null) {
  if (!member) return {
    member: null, checkInCount: 0, nextCourse: null, upcomingBookings: 0,
    coursesEnabled: false, checkInsEnabled: false, waitlistEmailEnabled: false,
  };
  const [coursesEnabled, checkInsEnabled] = await Promise.all([
    isModuleEnabled(member.organizationId, "courses"),
    isModuleEnabled(member.organizationId, "members"),
  ]);
  const [[checkIns], [lastCheckIn], courses] = await Promise.all([
    checkInsEnabled
      ? db.select({ total: count() }).from(checkInsTable).where(eq(checkInsTable.memberId, member.id))
      : Promise.resolve([{ total: 0 }]),
    checkInsEnabled
      ? db.select({ checkedInAt: checkInsTable.checkedInAt }).from(checkInsTable)
        .where(eq(checkInsTable.memberId, member.id))
        .orderBy(desc(checkInsTable.checkedInAt)).limit(1)
      : Promise.resolve([]),
    coursesEnabled ? memberCourses(member) : Promise.resolve([]),
  ]);
  const bookings = courses.filter((course) => course.bookingStatus === "confirmed");
  const { organizationId: _organizationId, waitlistEmailEnabled, ...publicMember } = member;
  return {
    member: { ...publicMember, lastCheckIn: lastCheckIn?.checkedInAt ?? null },
    checkInCount: checkIns.total,
    coursesEnabled,
    checkInsEnabled,
    waitlistEmailEnabled: waitlistEmailEnabled === 1,
    nextCourse: bookings[0] ?? null,
    upcomingBookings: bookings.length,
  };
}

router.get("/member/me", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  res.json(GetMemberHomeResponse.parse(await memberHome(await linkedMember(userId))));
});

router.patch("/member/me/profile", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const member = await linkedMember(userId);
  if (!member) { res.status(403).json({ error: "Eine verbundene Mitgliedschaft ist erforderlich." }); return; }
  const body = UpdateOwnMemberProfileBody.safeParse(req.body);
  if (!body.success || Object.keys(body.data ?? {}).length === 0) {
    res.status(400).json({ error: body.success ? "Keine Änderungen angegeben." : body.error.message });
    return;
  }
  const identity = await getClerkIdentity(userId);
  if (!identity.emailVerified) {
    res.status(403).json({ error: "Bitte bestätige zuerst deine Konto-E-Mail-Adresse." });
    return;
  }
  const [updated] = await db.update(membersTable).set({
    ...body.data,
    email: identity.email,
    ...(body.data.fullName !== undefined ? { fullName: body.data.fullName.trim() } : {}),
    ...(body.data.phone !== undefined ? { phone: body.data.phone?.trim() || null } : {}),
    ...(body.data.address !== undefined ? { address: body.data.address?.trim() || null } : {}),
    ...(body.data.birthDate !== undefined ? { birthDate: body.data.birthDate || null } : {}),
  }).where(eq(membersTable.id, member.id)).returning({ id: membersTable.id });
  if (!updated) { res.status(404).json({ error: "Mitgliedschaft nicht gefunden." }); return; }
  res.json(GetMemberHomeResponse.parse(await memberHome(await linkedMember(userId))));
});

router.get("/member/me/billing", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const member = await linkedMember(userId);
  if (!member) { res.status(403).json({ error: "Eine verbundene Mitgliedschaft ist erforderlich." }); return; }
  let billingStatus = member.billingStatus;
  let subscriptionId = member.stripeSubscriptionId;
  try {
    const stripe = await getStripeClient();
    if (member.stripeCheckoutSessionId && billingStatus === "checkout_pending") {
      const session = await stripe.checkoutSessions.retrieve(member.stripeCheckoutSessionId);
      if (session.status === "expired") {
        billingStatus = "not_started";
        await db.update(membersTable).set({ billingStatus, stripeCheckoutSessionId: null })
          .where(eq(membersTable.id, member.id));
      }
    }
    if (member.stripeCustomerId) {
      const subscriptions = await stripe.subscriptions.list({ customer: member.stripeCustomerId, status: "all", limit: 100 });
      const current = subscriptions.data.find(item => item.status !== "canceled") ?? subscriptions.data[0];
      if (current) {
        subscriptionId = current.id;
        billingStatus = current.status === "active" || current.status === "trialing" ? "active"
          : current.status === "past_due" || current.status === "unpaid" ? "past_due"
            : current.status === "canceled" ? "canceled" : "pending";
        await db.update(membersTable).set({ billingStatus, stripeSubscriptionId: subscriptionId })
          .where(eq(membersTable.id, member.id));
      }
    }
  } catch {
    // Preserve the last known status if Stripe is temporarily unavailable.
  }
  res.json(GetMemberBillingResponse.parse({
    status: billingStatus,
    billingInterval: member.billingInterval,
    membershipType: member.membershipType,
    canStartCheckout: member.status === "active" &&
      ["not_started", "canceled"].includes(billingStatus),
  }));
});

router.post("/member/me/billing", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const member = await linkedMember(userId);
  if (!member || member.status !== "active") {
    res.status(403).json({ error: "Ein aktives, verbundenes Mitgliedskonto ist erforderlich." }); return;
  }
  if (!["not_started", "canceled"].includes(member.billingStatus)) {
    res.status(409).json({ error: "Für diese Mitgliedschaft wurde die SEPA-Abrechnung bereits gestartet." }); return;
  }
  const origin = req.get("origin");
  if (!origin) { res.status(400).json({ error: "Die sichere Rücksprungadresse fehlt." }); return; }
  let returnBase: URL;
  try { returnBase = new URL(origin); } catch {
    res.status(400).json({ error: "Ungültige Rücksprungadresse." }); return;
  }
  const allowedHosts = [
    ...(process.env.REPLIT_DOMAINS ?? "").split(","),
    process.env.REPLIT_DEV_DOMAIN ?? "",
    "localhost",
    "127.0.0.1",
  ].filter(Boolean);
  if (!allowedHosts.includes(returnBase.host)) {
    res.status(400).json({ error: "Ungültige Rücksprungadresse." }); return;
  }
  const normalize = (value: string) => value.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ").toLowerCase();
  const tariff = normalize(member.membershipType);
  const [plan] = await db.select().from(membershipPlansTable).where(and(
    eq(membershipPlansTable.organizationId, member.organizationId),
    eq(membershipPlansTable.name, member.membershipType),
    eq(membershipPlansTable.active, 1),
  )).limit(1);
  if (!plan) { res.status(409).json({ error: "Für diesen Tarif ist noch kein aktiver Preis im Adminbereich eingerichtet." }); return; }
  const intervalCount = member.billingInterval === "annual" ? 12 : member.billingInterval === "semiannual" ? 6 : 1;
  const discount = member.billingInterval === "annual" ? plan.annualDiscountPercent
    : member.billingInterval === "semiannual" ? plan.semiannualDiscountPercent : 0;
  const expectedAmount = Math.round(plan.monthlyPriceCents * intervalCount * (100 - discount) / 100);

  try {
    const stripe = await getStripeClient();
    const products = await stripe.products.list({ active: true, limit: 100 });
    const product = products.data.find(item => item.metadata.fiudia_tariff === tariff)
      ?? await stripe.products.create({ name: member.membershipType, metadata: { fiudia_tariff: tariff } });
    const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
    const price = prices.data.find(item =>
      item.currency === "eur" && item.unit_amount === expectedAmount &&
      item.recurring?.interval === "month" && item.recurring.interval_count === intervalCount);
    const resolvedPrice = price ?? await stripe.prices.create({
      product: product.id, currency: "eur", unit_amount: expectedAmount,
      recurring: { interval: "month", interval_count: intervalCount },
      metadata: { fiudia_tariff: tariff, fiudia_interval: member.billingInterval },
    });
    const customer = member.stripeCustomerId
      ? await stripe.customers.retrieve(member.stripeCustomerId)
      : await stripe.customers.create({
        email: member.email,
        name: member.fullName,
        metadata: { fiudia_member_id: String(member.id), fiudia_studio_id: String(member.studioId) },
      });
    if (customer.deleted) {
      res.status(409).json({ error: "Das verbundene Stripe-Konto muss vom Studio geprüft werden." }); return;
    }
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      allowed_payment_method_types: ["sepa_debit"],
      line_items: [{ price: resolvedPrice.id, quantity: 1 }],
      client_reference_id: String(member.id),
      metadata: { fiudia_member_id: String(member.id) },
      subscription_data: { metadata: { fiudia_member_id: String(member.id), fiudia_tariff: tariff } },
      success_url: `${returnBase.origin}/fiudia-members/profile?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnBase.origin}/fiudia-members/profile?billing=cancelled`,
    });
    if (!session.url) {
      res.status(502).json({ error: "Stripe hat keinen Checkout-Link zurückgegeben." });
      return;
    }
    await db.update(membersTable).set({
      stripeCustomerId: customer.id,
      billingStatus: "checkout_pending",
      stripeCheckoutSessionId: session.id,
    }).where(eq(membersTable.id, member.id));
    res.json(CreateMemberBillingCheckoutResponse.parse({ url: session.url }));
  } catch (error) {
    res.status(502).json({ error: "Stripe konnte den SEPA-Checkout nicht starten. Bitte versuche es später erneut." });
  }
});

router.post("/member/push-subscriptions", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const member = await linkedMember(userId);
  if (!member || member.status !== "active") {
    res.status(403).json({ error: "Ein aktives, verbundenes Mitgliedskonto ist erforderlich." }); return;
  }
  if (!(await isModuleEnabled(member.organizationId, "courses"))) {
    res.status(403).json({ error: "Kurse sind für diese Organisation nicht verfügbar." }); return;
  }
  const body = RegisterMemberPushSubscriptionBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Ungültige Push-Abonnement-ID." }); return; }

  const [subscription] = await db.insert(memberPushSubscriptionsTable).values({
    subscriptionId: body.data.subscriptionId,
    memberId: member.id,
  }).onConflictDoNothing({ target: memberPushSubscriptionsTable.subscriptionId })
    .returning({ subscriptionId: memberPushSubscriptionsTable.subscriptionId });
  if (!subscription) {
    const [existing] = await db.select({
      memberId: memberPushSubscriptionsTable.memberId,
    }).from(memberPushSubscriptionsTable)
      .where(eq(memberPushSubscriptionsTable.subscriptionId, body.data.subscriptionId))
      .limit(1);
    if (existing && existing.memberId !== member.id) {
      res.status(409).json({ error: "Dieses Push-Abonnement ist bereits mit einem anderen Mitgliedskonto verknüpft." });
      return;
    }
  }
  res.json(RegisterMemberPushSubscriptionResponse.parse({
    subscriptionId: body.data.subscriptionId,
    registered: true,
  }));
});

router.delete("/member/push-subscriptions/:subscriptionId", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const member = await linkedMember(userId);
  if (!member) { res.status(403).json({ error: "Mitgliedschaft zuerst verbinden." }); return; }
  const params = UnregisterMemberPushSubscriptionParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Ungültige Push-Abonnement-ID." }); return; }
  await db.delete(memberPushSubscriptionsTable).where(and(
    eq(memberPushSubscriptionsTable.subscriptionId, params.data.subscriptionId),
    eq(memberPushSubscriptionsTable.memberId, member.id),
  ));
  res.json(UnregisterMemberPushSubscriptionResponse.parse({
    subscriptionId: params.data.subscriptionId,
    registered: false,
  }));
});

router.patch("/member/notification-settings", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const member = await linkedMember(userId);
  if (!member) { res.status(403).json({ error: "Mitgliedschaft zuerst verbinden." }); return; }
  if (!(await isModuleEnabled(member.organizationId, "courses"))) {
    res.status(403).json({ error: "Kurse sind nicht verfügbar." }); return;
  }
  const body = UpdateMemberNotificationSettingsBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Ungültige E-Mail-Einstellung." }); return; }
  await db.transaction(async (tx) => {
    await tx.update(membersTable)
      .set({ waitlistEmailEnabled: body.data.waitlistEmailEnabled ? 1 : 0 })
      .where(and(eq(membersTable.id, member.id), eq(membersTable.clerkUserId, userId)));
    if (!body.data.waitlistEmailEnabled) {
      await tx.update(memberNotificationsTable)
        .set({ emailRequested: 0 })
        .where(eq(memberNotificationsTable.memberId, member.id));
      // Pending/retryable messages are canceled here. A provider request already
      // in flight may complete; its actual provider outcome is retained.
      await tx.update(waitlistEmailDeliveriesTable)
        .set({
          status: "skipped",
          error: "Member opted out before delivery.",
          claimToken: null,
          claimedAt: null,
        })
        .where(and(
          eq(waitlistEmailDeliveriesTable.memberId, member.id),
          inArray(waitlistEmailDeliveriesTable.status, ["pending", "failed"]),
        ));
    }
  });
  res.json(UpdateMemberNotificationSettingsResponse.parse(await memberHome(await linkedMember(userId))));
});

router.post("/member/claim", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const body = ClaimMembershipBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Ungültige Mitgliedsnummer." }); return; }
  const identity = await getClerkIdentity(userId);
  if (!identity.emailVerified) {
    res.status(403).json({ error: "Bitte bestätige zuerst deine E-Mail-Adresse." }); return;
  }
  try {
    await linkMembership(userId, identity.email, body.data.memberId);
  } catch (error) {
    if (error instanceof MemberLinkError) {
      res.status(error.status).json({ error: error.message }); return;
    }
    throw error;
  }
  res.json(ClaimMembershipResponse.parse(await memberHome(await linkedMember(userId))));
});

router.get("/member/courses", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const member = await linkedMember(userId);
  if (!member) { res.status(403).json({ error: "Mitgliedschaft zuerst verbinden." }); return; }
  if (!(await isModuleEnabled(member.organizationId, "courses"))) {
    res.status(404).json({ error: "Kurse sind für diese Organisation nicht verfügbar." }); return;
  }
  const query = ListMemberCoursesQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Ungültiger Kurs." }); return; }
  res.json(ListMemberCoursesResponse.parse(await memberCourses(member, query.data.courseId)));
});

router.get("/member/courses/:id", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const member = await linkedMember(userId);
  if (!member) { res.status(403).json({ error: "Mitgliedschaft zuerst verbinden." }); return; }
  if (!(await isModuleEnabled(member.organizationId, "courses"))) {
    res.status(404).json({ error: "Kurs nicht gefunden." }); return;
  }
  const params = GetMemberCourseParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Ungültiger Kurs." }); return; }
  const [course] = await memberCourses(member, params.data.id, true);
  if (!course) { res.status(404).json({ error: "Kurs nicht gefunden." }); return; }
  res.json(GetMemberCourseResponse.parse(course));
});

router.post("/member/courses/:id/book", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const member = await linkedMember(userId);
  if (!member) { res.status(403).json({ error: "Mitgliedschaft zuerst verbinden." }); return; }
  if (!(await isModuleEnabled(member.organizationId, "courses"))) {
    res.status(404).json({ error: "Kurse sind nicht verfügbar." }); return;
  }
  const params = BookMemberCourseParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Ungültiger Kurs." }); return; }
  try {
    const booking = await bookCourse(params.data.id, member.id);
    res.status(201).json(BookMemberCourseResponse.parse(booking));
  } catch (error) {
    if (error instanceof BookingError) {
      res.status(error.status).json({ error: error.message }); return;
    }
    throw error;
  }
});

router.delete("/member/courses/:id/book", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const member = await linkedMember(userId);
  if (!member) { res.status(403).json({ error: "Mitgliedschaft zuerst verbinden." }); return; }
  if (!(await isModuleEnabled(member.organizationId, "courses"))) {
    res.status(404).json({ error: "Kurse sind nicht verfügbar." }); return;
  }
  const params = CancelMemberCourseParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Ungültiger Kurs." }); return; }
  const [course] = await db.select({ studioId: coursesTable.studioId })
    .from(coursesTable).where(eq(coursesTable.id, params.data.id)).limit(1);
  if (!course || course.studioId !== member.studioId) {
    res.status(404).json({ error: "Buchung nicht gefunden." }); return;
  }
  try {
    const booking = await cancelCourseBooking(params.data.id, member.id);
    res.json(CancelMemberCourseResponse.parse(booking));
  } catch (error) {
    if (error instanceof BookingError) {
      res.status(error.status).json({ error: error.message }); return;
    }
    throw error;
  }
});

router.get("/member/check-ins", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const member = await linkedMember(userId);
  if (!member) { res.status(403).json({ error: "Mitgliedschaft zuerst verbinden." }); return; }
  if (!(await isModuleEnabled(member.organizationId, "members"))) {
    res.status(404).json({ error: "Check-ins sind nicht verfügbar." }); return;
  }
  const checkIns = await db.select({
    id: checkInsTable.id, studioName: studiosTable.name,
    checkedInAt: checkInsTable.checkedInAt,
  }).from(checkInsTable)
    .innerJoin(studiosTable, eq(checkInsTable.studioId, studiosTable.id))
    .where(eq(checkInsTable.memberId, member.id))
    .orderBy(desc(checkInsTable.checkedInAt)).limit(50);
  res.json(ListMemberCheckInsResponse.parse(checkIns));
});

router.get("/member/notifications/unread-count", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const member = await linkedMember(userId);
  if (!member) { res.status(403).json({ error: "Mitgliedschaft zuerst verbinden." }); return; }
  if (!(await isModuleEnabled(member.organizationId, "courses"))) {
    res.status(404).json({ error: "Kurse sind nicht verfügbar." }); return;
  }
  const [result] = await db.select({ count: count() }).from(memberNotificationsTable)
    .where(and(
      eq(memberNotificationsTable.memberId, member.id),
      isNull(memberNotificationsTable.readAt),
    ));
  res.json(GetMemberNotificationUnreadCountResponse.parse(result));
});

router.get("/member/notifications", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const member = await linkedMember(userId);
  if (!member) { res.status(403).json({ error: "Mitgliedschaft zuerst verbinden." }); return; }
  if (!(await isModuleEnabled(member.organizationId, "courses"))) {
    res.status(404).json({ error: "Kurse sind nicht verfügbar." }); return;
  }
  const query = ListMemberNotificationsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Ungültiger Mitteilungs-Cursor." }); return;
  }
  const beforeId = query.data.beforeId;
  let cursor: { id: number; createdAt: Date } | undefined;
  if (beforeId !== undefined) {
    if (beforeId > 2_147_483_647) {
      res.status(400).json({ error: "Ungültiger Mitteilungs-Cursor." }); return;
    }
    [cursor] = await db.select({
      id: memberNotificationsTable.id,
      createdAt: memberNotificationsTable.createdAt,
    }).from(memberNotificationsTable)
      .where(and(
        eq(memberNotificationsTable.id, beforeId),
        eq(memberNotificationsTable.memberId, member.id),
      )).limit(1);
    if (!cursor) {
      res.status(400).json({ error: "Ungültiger Mitteilungs-Cursor." }); return;
    }
  }
  const notifications = await db.select({
    id: memberNotificationsTable.id,
    courseId: memberNotificationsTable.courseId,
    title: memberNotificationsTable.title,
    body: memberNotificationsTable.body,
    createdAt: memberNotificationsTable.createdAt,
    readAt: memberNotificationsTable.readAt,
    emailRequested: memberNotificationsTable.emailRequested,
    emailDeliveryStatus: waitlistEmailDeliveriesTable.status,
  }).from(memberNotificationsTable)
    .leftJoin(waitlistEmailDeliveriesTable, and(
      eq(waitlistEmailDeliveriesTable.notificationId, memberNotificationsTable.id),
      eq(waitlistEmailDeliveriesTable.memberId, member.id),
    ))
    .where(and(
      eq(memberNotificationsTable.memberId, member.id),
      ...(cursor ? [or(
        lt(memberNotificationsTable.createdAt, cursor.createdAt),
        and(
          eq(memberNotificationsTable.createdAt, cursor.createdAt),
          lt(memberNotificationsTable.id, cursor.id),
        ),
      )!] : []),
    ))
    .orderBy(desc(memberNotificationsTable.createdAt), desc(memberNotificationsTable.id))
    .limit(50);
  res.json(ListMemberNotificationsResponse.parse(notifications.map(({ emailRequested, ...notice }) => ({
    ...notice,
    emailDeliveryStatus: emailRequested ? notice.emailDeliveryStatus : null,
  }))));
});

router.patch("/member/notifications/:id/read", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const member = await linkedMember(userId);
  if (!member) { res.status(403).json({ error: "Mitgliedschaft zuerst verbinden." }); return; }
  if (!(await isModuleEnabled(member.organizationId, "courses"))) {
    res.status(404).json({ error: "Kurse sind nicht verfügbar." }); return;
  }
  const params = MarkMemberNotificationReadParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Ungültige Mitteilung." }); return; }
  const [notification] = await db.update(memberNotificationsTable)
    .set({ readAt: new Date() })
    .where(and(
      eq(memberNotificationsTable.id, params.data.id),
      eq(memberNotificationsTable.memberId, member.id),
    ))
    .returning({
      id: memberNotificationsTable.id, courseId: memberNotificationsTable.courseId,
      title: memberNotificationsTable.title, body: memberNotificationsTable.body,
      createdAt: memberNotificationsTable.createdAt, readAt: memberNotificationsTable.readAt,
      emailRequested: memberNotificationsTable.emailRequested,
    });
  if (!notification) { res.status(404).json({ error: "Mitteilung nicht gefunden." }); return; }
  const [delivery] = notification.emailRequested ? await db.select({
    status: waitlistEmailDeliveriesTable.status,
  }).from(waitlistEmailDeliveriesTable).where(and(
    eq(waitlistEmailDeliveriesTable.notificationId, notification.id),
    eq(waitlistEmailDeliveriesTable.memberId, member.id),
  )).limit(1) : [];
  const { emailRequested, ...readNotice } = notification;
  res.json(MarkMemberNotificationReadResponse.parse({
    ...readNotice,
    emailDeliveryStatus: emailRequested ? delivery?.status ?? null : null,
  }));
});

export default router;