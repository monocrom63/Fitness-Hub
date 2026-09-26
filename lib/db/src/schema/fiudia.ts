import {
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
  studioId: integer("studio_id")
    .notNull()
    .references(() => studiosTable.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  membershipType: text("membership_type").notNull(),
  status: text("status").notNull().default("active"),
  joinedAt: timestamp("joined_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
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
  authorStaffId: integer("author_staff_id")
    .notNull()
    .references(() => staffTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  priority: text("priority").notNull().default("info"),
  audience: text("audience").notNull().default("all"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
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