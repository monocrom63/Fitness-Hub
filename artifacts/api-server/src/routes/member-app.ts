import { and, asc, count, desc, eq, gte, inArray } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  BookMemberCourseParams, BookMemberCourseResponse,
  CancelMemberCourseParams, CancelMemberCourseResponse,
  ClaimMembershipBody, ClaimMembershipResponse,
  GetMemberHomeResponse, ListMemberCheckInsResponse, ListMemberCoursesQueryParams, ListMemberCoursesResponse,
  ListMemberNotificationsResponse, MarkMemberNotificationReadParams,
  MarkMemberNotificationReadResponse,
  RegisterMemberPushSubscriptionBody, RegisterMemberPushSubscriptionResponse,
  UpdateMemberNotificationSettingsBody, UpdateMemberNotificationSettingsResponse,
  UnregisterMemberPushSubscriptionParams, UnregisterMemberPushSubscriptionResponse,
} from "@workspace/api-zod";
import {
  checkInsTable, courseBookingsTable, coursesTable, db, memberNotificationsTable,
  memberPushSubscriptionsTable, membersTable, studiosTable, waitlistEmailDeliveriesTable,
} from "@workspace/db";
import { BookingError, bookCourse, cancelCourseBooking } from "../lib/course-bookings";
import { getClerkIdentity, getRequestUserId } from "../lib/fiudia-access";
import { linkMembership, MemberLinkError } from "../lib/member-link";
import { isModuleEnabled } from "../lib/module-access";

const router: IRouter = Router();

export async function linkedMember(userId: string) {
  const [member] = await db.select({
    id: membersTable.id,
    fullName: membersTable.fullName,
    email: membersTable.email,
    phone: membersTable.phone,
    membershipType: membersTable.membershipType,
    status: membersTable.status,
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

async function memberCourses(member: LinkedMember, requestedId?: number) {
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
  }).from(coursesTable)
    .where(and(
      eq(coursesTable.studioId, member.studioId),
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

router.get("/member/notifications", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Anmeldung erforderlich." }); return; }
  const member = await linkedMember(userId);
  if (!member) { res.status(403).json({ error: "Mitgliedschaft zuerst verbinden." }); return; }
  if (!(await isModuleEnabled(member.organizationId, "courses"))) {
    res.status(404).json({ error: "Kurse sind nicht verfügbar." }); return;
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
    .where(eq(memberNotificationsTable.memberId, member.id))
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