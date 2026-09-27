import {
  date,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const organizationsTable = pgTable("fiudia_organizations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const organizationModulesTable = pgTable(
  "fiudia_organization_modules",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    enabled: integer("enabled").notNull().default(1),
  },
  (table) => [unique("fiudia_organization_module_key").on(table.organizationId, table.key)],
);

export const studiosTable = pgTable("fiudia_studios", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  city: text("city").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const staffTable = pgTable(
  "fiudia_staff",
  {
    id: serial("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull().unique(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    studioId: integer("studio_id").references(() => studiosTable.id, {
      onDelete: "cascade",
    }),
    fullName: text("full_name").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique("fiudia_staff_org_email").on(table.organizationId, table.email)],
);

export const invitationsTable = pgTable("fiudia_invitations", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  studioId: integer("studio_id")
    .notNull()
    .references(() => studiosTable.id, { onDelete: "cascade" }),
  invitedByStaffId: integer("invited_by_staff_id")
    .notNull()
    .references(() => staffTable.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const membersTable = pgTable("fiudia_members", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").unique(),
  studioId: integer("studio_id")
    .notNull()
    .references(() => studiosTable.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  membershipType: text("membership_type").notNull(),
  status: text("status").notNull().default("active"),
  waitlistEmailEnabled: integer("waitlist_email_enabled").notNull().default(0),
  joinedAt: timestamp("joined_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const memberInvitationsTable = pgTable("fiudia_member_invitations", {
  id: serial("id").primaryKey(),
  memberId: integer("member_id")
    .notNull()
    .references(() => membersTable.id, { onDelete: "cascade" }),
  studioId: integer("studio_id")
    .notNull()
    .references(() => studiosTable.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  invitedByStaffId: integer("invited_by_staff_id")
    .notNull()
    .references(() => staffTable.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const coursesTable = pgTable("fiudia_courses", {
  id: serial("id").primaryKey(),
  studioId: integer("studio_id")
    .notNull()
    .references(() => studiosTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  instructor: text("instructor").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  capacity: integer("capacity").notNull(),
  enrolled: integer("enrolled").notNull().default(0),
  room: text("room").notNull(),
  status: text("status").notNull().default("scheduled"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const roomsTable = pgTable(
  "fiudia_rooms",
  {
    id: serial("id").primaryKey(),
    studioId: integer("studio_id")
      .notNull()
      .references(() => studiosTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("fiudia_room_studio_name").on(table.studioId, table.name)],
);

export const roomClosuresTable = pgTable("fiudia_room_closures", {
  id: serial("id").primaryKey(),
  studioId: integer("studio_id")
    .notNull()
    .references(() => studiosTable.id, { onDelete: "cascade" }),
  roomName: text("room_name").notNull(),
  fromDate: date("from_date", { mode: "string" }).notNull(),
  toDate: date("to_date", { mode: "string" }).notNull(),
  reason: text("reason").notNull(),
  responsible: text("responsible").notNull(),
  createdByStaffId: integer("created_by_staff_id")
    .notNull()
    .references(() => staffTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const courseBookingsTable = pgTable(
  "fiudia_course_bookings",
  {
    id: serial("id").primaryKey(),
    courseId: integer("course_id")
      .notNull()
      .references(() => coursesTable.id, { onDelete: "cascade" }),
    memberId: integer("member_id")
      .notNull()
      .references(() => membersTable.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("confirmed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("fiudia_course_booking_member").on(table.courseId, table.memberId)],
);

export const memberNotificationsTable = pgTable("fiudia_member_notifications", {
  id: serial("id").primaryKey(),
  bookingId: integer("booking_id")
    .notNull()
    .references(() => courseBookingsTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id")
    .notNull()
    .references(() => membersTable.id, { onDelete: "cascade" }),
  courseId: integer("course_id")
    .notNull()
    .references(() => coursesTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  emailRequested: integer("email_requested").notNull().default(0),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memberPushSubscriptionsTable = pgTable("fiudia_member_push_subscriptions", {
  subscriptionId: text("subscription_id").primaryKey(),
  memberId: integer("member_id").notNull().references(() => membersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const courseClosureResolutionsTable = pgTable(
  "fiudia_course_closure_resolutions",
  {
    id: serial("id").primaryKey(),
    courseId: integer("course_id")
      .notNull()
      .references(() => coursesTable.id, { onDelete: "cascade" }),
    closureId: integer("closure_id")
      .notNull()
      .references(() => roomClosuresTable.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    targetRoom: text("target_room"),
    channel: text("channel").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("fiudia_course_closure_resolution_course_closure").on(table.courseId, table.closureId),
    unique("fiudia_course_closure_resolution_idempotency").on(table.idempotencyKey),
  ],
);

export const closureEmailDeliveriesTable = pgTable(
  "fiudia_closure_email_deliveries",
  {
    id: serial("id").primaryKey(),
    resolutionId: integer("resolution_id")
      .notNull()
      .references(() => courseClosureResolutionsTable.id, { onDelete: "restrict" }),
    bookingId: integer("booking_id")
      .notNull()
      .references(() => courseBookingsTable.id, { onDelete: "cascade" }),
    memberId: integer("member_id")
      .notNull()
      .references(() => membersTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    providerId: text("provider_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    claimToken: text("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("fiudia_closure_email_resolution_booking").on(table.resolutionId, table.bookingId),
  ],
);

export const closurePushDeliveriesTable = pgTable(
  "fiudia_closure_push_deliveries",
  {
    id: serial("id").primaryKey(),
    resolutionId: integer("resolution_id").notNull().references(() => courseClosureResolutionsTable.id, { onDelete: "restrict" }),
    bookingId: integer("booking_id").notNull().references(() => courseBookingsTable.id, { onDelete: "cascade" }),
    memberId: integer("member_id").notNull().references(() => membersTable.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    providerId: text("provider_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    claimToken: text("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("fiudia_closure_push_resolution_subscription").on(table.resolutionId, table.subscriptionId)],
);

export const checkInsTable = pgTable("fiudia_check_ins", {
  id: serial("id").primaryKey(),
  memberId: integer("member_id")
    .notNull()
    .references(() => membersTable.id, { onDelete: "cascade" }),
  studioId: integer("studio_id")
    .notNull()
    .references(() => studiosTable.id, { onDelete: "cascade" }),
  checkedInByStaffId: integer("checked_in_by_staff_id")
    .notNull()
    .references(() => staffTable.id, { onDelete: "cascade" }),
  checkedInAt: timestamp("checked_in_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const pulseMessagesTable = pgTable("fiudia_pulse_messages", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  studioId: integer("studio_id").references(() => studiosTable.id, {
    onDelete: "cascade",
  }),
  roomClosureId: integer("room_closure_id").references(() => roomClosuresTable.id, {
    onDelete: "set null",
  }),
  authorStaffId: integer("author_staff_id")
    .notNull()
    .references(() => staffTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  priority: text("priority").notNull().default("info"),
  audience: text("audience").notNull().default("all"),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  retractedAt: timestamp("retracted_at", { withTimezone: true }),
});

export const pulseCorrectionsTable = pgTable("fiudia_pulse_corrections", {
  id: serial("id").primaryKey(),
  messageId: integer("message_id")
    .notNull()
    .references(() => pulseMessagesTable.id, { onDelete: "cascade" }),
  editorStaffId: integer("editor_staff_id").notNull(),
  editorName: text("editor_name").notNull(),
  oldTitle: text("old_title").notNull(),
  newTitle: text("new_title").notNull(),
  oldBody: text("old_body").notNull(),
  newBody: text("new_body").notNull(),
  oldPriority: text("old_priority").notNull(),
  newPriority: text("new_priority").notNull(),
  editedAt: timestamp("edited_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pulseReadsTable = pgTable(
  "fiudia_pulse_reads",
  {
    id: serial("id").primaryKey(),
    messageId: integer("message_id")
      .notNull()
      .references(() => pulseMessagesTable.id, { onDelete: "cascade" }),
    staffId: integer("staff_id")
      .notNull()
      .references(() => staffTable.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("fiudia_pulse_reads_message_staff").on(
      table.messageId,
      table.staffId,
    ),
  ],
);