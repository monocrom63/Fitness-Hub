import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  ConfirmMarketingCheckoutBody, ConfirmMarketingCheckoutResponse, CreateMarketingCampaignBody,
  CreateMarketingCampaignResponse, CreateMarketingCheckoutResponse, CreateMarketingBillingPortalResponse,
  GetExternalMarketingAudienceCountHeader, GetExternalMarketingAudienceCountQueryParams,
  GetExternalMarketingAudienceCountResponse, GetMarketingApiKeyResponse,
  GetMarketingAudienceCountQueryParams, GetMarketingAudienceCountResponse,
  GetMarketingSubscriptionResponse, ListMarketingCampaignsResponse,
  ListOneSignalMarketingRecipientsResponse, SendOneSignalMarketingMessageBody,
  SendOneSignalMarketingMessageResponse,
  RequestMarketingImageUploadBody, RequestMarketingImageUploadResponse,
  RotateMarketingApiKeyResponse, SendMarketingCampaignParams, SendMarketingCampaignResponse,
  UnsubscribeFromMarketingResponse,
} from "@workspace/api-zod";
import {
  db, marketingApiKeysTable, marketingCampaignsTable, marketingDeliveriesTable,
  marketingSubscriptionsTable, marketingUnsubscribeTokensTable, membersTable,
  memberPushSubscriptionsTable, studiosTable,
} from "@workspace/db";
import { getRequestUserId, getRequestStaffContext, isOrganizationAdmin, type StaffContext } from "../lib/fiudia-access";
import { createMarketingImageUpload, getMarketingImageFile, pipeMarketingImage } from "../lib/studio-logos";
import { getStripeClient } from "../lib/stripe-client";
import { resendRequest } from "../lib/resend-client";
import { getApprovedApiRequest, hasCurrentApprovedApiAccess } from "../lib/api-access";
import { closurePushReadiness, ONESIGNAL_APP_ID, oneSignalProxy } from "../lib/closure-push";
import { buildPushMarketingMemberIds, buildSmsMarketingPhoneNumbers, isSmsMarketingEligible } from "../lib/marketing-onesignal";

const router: IRouter = Router();
const activeCache = new Map<number, { expires: number; active: boolean; status: string; currentPeriodEnd: Date | null }>();
const apiRateLimits = new Map<string, { started: number; count: number }>();
const MAX_AUDIENCE = 1000;
const audienceFilterSchema = z.object({
  gender: z.enum(["all", "male", "female", "diverse"]).default("all"),
  ageFrom: z.number().int().min(0).max(120).nullable().default(null),
  ageTo: z.number().int().min(0).max(120).nullable().default(null),
  city: z.string().trim().max(120).nullable().default(null),
  studioId: z.number().int().nullable().default(null),
});

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function statusFromStripe(value: string) {
  return (["active", "trialing", "past_due", "canceled", "unpaid"].includes(value) ? value : "inactive") as
    "inactive" | "active" | "trialing" | "past_due" | "canceled" | "unpaid";
}
function trustedOrigin(req: Request) {
  const configured = [
    ...(process.env.REPLIT_DOMAINS ?? "").split(","),
    process.env.REPLIT_DEV_DOMAIN ?? "",
  ].map((value) => value.trim().toLowerCase()).filter(Boolean);
  const host = (req.get("host") ?? "").toLowerCase();
  if (configured.includes(host)) return `https://${host}`;
  const fallback = configured[0];
  if (fallback) return `https://${fallback}`;
  if (host === "localhost" || host.startsWith("localhost:") || host.startsWith("127.0.0.1:")) {
    return `${req.protocol}://${host}`;
  }
  throw new Error("A configured Fiudia domain is required for marketing links.");
}
function normalizedFilters(input: unknown) {
  return audienceFilterSchema.parse({
    gender: "all", ageFrom: null, ageTo: null, city: null, studioId: null,
    ...(input && typeof input === "object" ? input : {}),
  });
}
function scopedFilters(staff: StaffContext, filters: ReturnType<typeof normalizedFilters>) {
  if (staff.role !== "studio_manager") return filters;
  if (!staff.studioId) throw new Error("Für diese Studioleitung ist kein Studio zugeordnet.");
  if (filters.studioId !== null && filters.studioId !== staff.studioId) {
    throw new Error("Du kannst nur Zielgruppen deines eigenen Studios auswählen.");
  }
  return { ...filters, studioId: staff.studioId };
}
function filterConditions(organizationId: number, filters: ReturnType<typeof normalizedFilters>) {
  const conditions = [
    eq(studiosTable.organizationId, organizationId),
    eq(membersTable.status, "active"),
  ];
  if (filters.gender !== "all") conditions.push(eq(membersTable.gender, filters.gender));
  if (filters.ageFrom !== null) conditions.push(sql<boolean>`${membersTable.birthDate} IS NOT NULL AND date_part('year', age(CURRENT_DATE, ${membersTable.birthDate})) >= ${filters.ageFrom}`);
  if (filters.ageTo !== null) conditions.push(sql<boolean>`${membersTable.birthDate} IS NOT NULL AND date_part('year', age(CURRENT_DATE, ${membersTable.birthDate})) <= ${filters.ageTo}`);
  if (filters.city) conditions.push(eq(studiosTable.city, filters.city));
  if (filters.studioId !== null) conditions.push(eq(membersTable.studioId, filters.studioId));
  return conditions;
}
async function audienceCounts(organizationId: number, filters: ReturnType<typeof normalizedFilters>) {
  if (filters.ageFrom !== null && filters.ageTo !== null && filters.ageFrom > filters.ageTo) {
    throw new Error("Das Mindestalter darf nicht über dem Höchstalter liegen.");
  }
  if (filters.studioId !== null) {
    const [studio] = await db.select({ id: studiosTable.id }).from(studiosTable)
      .where(and(eq(studiosTable.id, filters.studioId), eq(studiosTable.organizationId, organizationId))).limit(1);
    if (!studio) throw new Error("Das gewählte Studio gehört nicht zu dieser Organisation.");
  }
  const conditions = filterConditions(organizationId, filters);
  const [[all], [eligible]] = await Promise.all([
    db.select({ count: count() }).from(membersTable).innerJoin(studiosTable, eq(membersTable.studioId, studiosTable.id)).where(and(...conditions)),
    db.select({ count: count() }).from(membersTable).innerJoin(studiosTable, eq(membersTable.studioId, studiosTable.id))
      .where(and(...conditions, eq(membersTable.marketingConsent, 1))),
  ]);
  return { count: Number(all.count), eligibleEmailCount: Number(eligible.count) };
}
async function submitOneSignal(body: Record<string, unknown>, channel: "sms" | "push") {
  try {
    const response = await oneSignalProxy("/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const result = await response.json().catch(() => ({})) as {
      id?: string;
      errors?: string[];
      error?: { message?: string };
    };
    const providerMessage = result.error?.message ?? result.errors?.[0] ?? "";
    if (!response.ok || /not subscribed/i.test(providerMessage)) {
      const error = /not subscribed/i.test(providerMessage)
        ? channel === "sms"
          ? "OneSignal hat keine aktive SMS-Einwilligung für die ausgewählten Nummern erkannt. SMS-Opt-in und SMS-Kanal müssen bei OneSignal eingerichtet sein."
          : "Für die Auswahl sind keine aktiven OneSignal-Push-Abonnements vorhanden."
        : providerMessage || `OneSignal antwortete mit HTTP ${response.status}.`;
      return { id: null, error: error.slice(0, 300) };
    }
    if (!result.id) return { id: null, error: "OneSignal hat keine Nachrichten-ID zurückgegeben; es wurde keine Zustellung bestätigt." };
    return { id: result.id, error: null };
  } catch (error) {
    return { id: null, error: error instanceof Error ? error.message.slice(0, 300) : "OneSignal ist derzeit nicht erreichbar." };
  }
}
async function getStaff(req: Request, res: Response) {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Bitte melde dich an." }); return null; }
  const staff = await getRequestStaffContext(req);
  if (!staff) { res.status(403).json({ error: "Für dieses Konto ist kein Fiudia-Zugang hinterlegt." }); return null; }
  if (staff.role === "studio_employee") { res.status(403).json({ error: "Marketing ist nur für Studio- und Bezirksleitungen verfügbar." }); return null; }
  return staff;
}
async function subscriptionState(organizationId: number, force = false) {
  const cached = activeCache.get(organizationId);
  if (!force && cached && cached.expires > Date.now()) return cached;
  const [row] = await db.select().from(marketingSubscriptionsTable)
    .where(eq(marketingSubscriptionsTable.organizationId, organizationId)).limit(1);
  if (!row?.stripeSubscriptionId) {
    const testAccess = process.env.NODE_ENV !== "production" && row?.status === "test_access";
    const state = {
      expires: Date.now() + 30_000,
      active: testAccess,
      status: testAccess ? "test_access" : row?.status === "test_access" ? "inactive" : row?.status ?? "inactive",
      currentPeriodEnd: row?.currentPeriodEnd ?? null,
    };
    activeCache.set(organizationId, state);
    return state;
  }
  try {
    const stripe = await getStripeClient();
    const subscription = await stripe.subscriptions.retrieve(row.stripeSubscriptionId);
    const status = statusFromStripe(subscription.status);
    const active = status === "active" || status === "trialing";
    const currentPeriodEnd = subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null;
    await db.update(marketingSubscriptionsTable).set({ status, currentPeriodEnd, updatedAt: new Date() })
      .where(eq(marketingSubscriptionsTable.organizationId, organizationId));
    const state = { expires: Date.now() + 30_000, active, status, currentPeriodEnd };
    activeCache.set(organizationId, state);
    return state;
  } catch {
    const state = { expires: Date.now() + 5_000, active: false, status: "inactive", currentPeriodEnd: null };
    activeCache.set(organizationId, state);
    return state;
  }
}
async function requirePaidStaff(req: Request, res: Response) {
  const staff = await getStaff(req, res);
  if (!staff) return null;
  const state = await subscriptionState(staff.organizationId);
  if (!state.active) { res.status(403).json({ error: "Das Marketing-Modul benötigt ein aktives Abonnement." }); return null; }
  return staff;
}
function campaignResponse(row: typeof marketingCampaignsTable.$inferSelect, origin: string) {
  return {
    id: row.id, headline: row.headline, bodyText: row.bodyText,
    imageUrl: `${origin}/api/marketing/images/${row.id}`,
    audience: normalizedFilters(row.audienceFilters), status: row.status,
    recipientCount: row.recipientCount, createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
  };
}
async function ensureMarketingPrice() {
  const stripe = await getStripeClient();
  const products = await stripe.products.list({ active: true, limit: 100 });
  let product = products.data.find((item) => item.metadata?.fiudia_module === "marketing");
  if (!product) product = await stripe.products.create({
    name: "Fiudia Marketing",
    description: "Fiudia Marketing-Modul, monatlich je Organisation.",
    metadata: { fiudia_module: "marketing", fiudia_scope: "organization" },
  });
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  let price = prices.data.find((item) => item.unit_amount === 9900 && item.currency === "eur" &&
    item.recurring?.interval === "month" && item.recurring.interval_count === 1);
  if (!price) price = await stripe.prices.create({
    product: product.id, unit_amount: 9900, currency: "eur",
    recurring: { interval: "month" }, metadata: { fiudia_module: "marketing" },
  });
  return { stripe, product, price };
}

router.get("/marketing/subscription", async (req, res): Promise<void> => {
  const staff = await getStaff(req, res);
  if (!staff) return;
  const state = await subscriptionState(staff.organizationId, true);
  res.json(GetMarketingSubscriptionResponse.parse({
    active: state.active, status: state.status, currentPeriodEnd: state.currentPeriodEnd,
  }));
});

router.post("/marketing/subscription/checkout", async (req, res): Promise<void> => {
  const staff = await getStaff(req, res);
  if (!staff) return;
  if (!isOrganizationAdmin(staff)) { res.status(403).json({ error: "Nur die Bezirksleitung kann das Organisationsabo abschließen." }); return; }
  try {
    const { stripe, price } = await ensureMarketingPrice();
    const [saved] = await db.select().from(marketingSubscriptionsTable)
      .where(eq(marketingSubscriptionsTable.organizationId, staff.organizationId)).limit(1);
    let customerId = saved?.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: staff.email, name: staff.organizationName,
        metadata: { fiudia_organization_id: String(staff.organizationId) },
      });
      customerId = customer.id;
    }
    const origin = trustedOrigin(req);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription", customer: customerId,
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: `${origin}/marketing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/marketing?checkout=cancel`,
      metadata: { fiudia_module: "marketing", fiudia_organization_id: String(staff.organizationId) },
      subscription_data: { metadata: { fiudia_module: "marketing", fiudia_organization_id: String(staff.organizationId) } },
    });
    await db.insert(marketingSubscriptionsTable).values({
      organizationId: staff.organizationId, stripeCustomerId: customerId, stripePriceId: price.id,
      status: "inactive",
    }).onConflictDoUpdate({
      target: marketingSubscriptionsTable.organizationId,
      set: { stripeCustomerId: customerId, stripePriceId: price.id, updatedAt: new Date() },
    });
    res.json(CreateMarketingCheckoutResponse.parse({ url: session.url }));
  } catch (error) {
    req.log.error({ err: error }, "Marketing checkout creation failed");
    res.status(502).json({ error: "Der Stripe-Checkout konnte nicht gestartet werden." });
  }
});

router.post("/marketing/subscription/confirm", async (req, res): Promise<void> => {
  const staff = await getStaff(req, res);
  if (!staff) return;
  const body = ConfirmMarketingCheckoutBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Ungültige Checkout-Sitzung." }); return; }
  try {
    const stripe = await getStripeClient();
    const session = await stripe.checkoutSessions.retrieve(body.data.sessionId);
    if (session.status !== "complete" || !["paid", "no_payment_required"].includes(session.payment_status) ||
      session.metadata?.fiudia_module !== "marketing" ||
      session.metadata?.fiudia_organization_id !== String(staff.organizationId) || !session.subscription || !session.customer) {
      res.status(409).json({ error: "Der Checkout ist noch nicht abgeschlossen." }); return;
    }
    const subscription = await stripe.subscriptions.retrieve(session.subscription);
    const status = statusFromStripe(subscription.status);
    const currentPeriodEnd = subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null;
    await db.insert(marketingSubscriptionsTable).values({
      organizationId: staff.organizationId, stripeCustomerId: session.customer,
      stripeSubscriptionId: subscription.id, status, currentPeriodEnd,
    }).onConflictDoUpdate({
      target: marketingSubscriptionsTable.organizationId,
      set: { stripeCustomerId: session.customer, stripeSubscriptionId: subscription.id, status, currentPeriodEnd, updatedAt: new Date() },
    });
    activeCache.delete(staff.organizationId);
    res.json(ConfirmMarketingCheckoutResponse.parse({
      active: status === "active" || status === "trialing", status, currentPeriodEnd,
    }));
  } catch (error) {
    req.log.error({ err: error }, "Marketing checkout confirmation failed");
    res.status(502).json({ error: "Der Checkout konnte nicht bestätigt werden." });
  }
});

router.post("/marketing/subscription/portal", async (req, res): Promise<void> => {
  const staff = await getStaff(req, res);
  if (!staff) return;
  if (!isOrganizationAdmin(staff)) { res.status(403).json({ error: "Nur die Bezirksleitung kann die Abrechnung verwalten." }); return; }
  const [subscription] = await db.select().from(marketingSubscriptionsTable)
    .where(eq(marketingSubscriptionsTable.organizationId, staff.organizationId)).limit(1);
  if (!subscription?.stripeCustomerId) { res.status(404).json({ error: "Kein Marketing-Abonnement gefunden." }); return; }
  try {
    const stripe = await getStripeClient();
    const session = await stripe.billingPortal.sessions.create({
      customer: subscription.stripeCustomerId, return_url: `${trustedOrigin(req)}/marketing`,
    });
    res.json(CreateMarketingBillingPortalResponse.parse({ url: session.url }));
  } catch (error) {
    req.log.error({ err: error }, "Marketing billing portal creation failed");
    res.status(502).json({ error: "Die Stripe-Abrechnung konnte nicht geöffnet werden." });
  }
});

router.get("/marketing/campaigns", async (req, res): Promise<void> => {
  const staff = await getStaff(req, res);
  if (!staff) return;
  const rows = await db.select().from(marketingCampaignsTable)
    .where(eq(marketingCampaignsTable.organizationId, staff.organizationId))
    .orderBy(asc(marketingCampaignsTable.createdAt));
  const origin = trustedOrigin(req);
  res.json(ListMarketingCampaignsResponse.parse(rows.map((row) => campaignResponse(row, origin))));
});

router.post("/marketing/campaigns", async (req, res): Promise<void> => {
  const staff = await getStaff(req, res);
  if (!staff) return;
  const body = CreateMarketingCampaignBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Bitte prüfe Headline, Text, Bild und Zielgruppe." }); return; }
  const expectedPrefix = `/objects/marketing/${staff.organizationId}/`;
  if (!body.data.imagePath.startsWith(expectedPrefix)) { res.status(400).json({ error: "Das Bild gehört nicht zu dieser Organisation." }); return; }
  const image = await getMarketingImageFile(body.data.imagePath);
  if (!image) { res.status(400).json({ error: "Das Kampagnenbild wurde nicht gefunden." }); return; }
  const [metadata] = await image.getMetadata();
  if (!["image/png", "image/jpeg", "image/webp"].includes(String(metadata.contentType)) || Number(metadata.size) > 5 * 1024 * 1024) {
    res.status(400).json({ error: "Das Kampagnenbild muss PNG, JPEG oder WebP sein und darf höchstens 5 MB groß sein." }); return;
  }
  let filters: ReturnType<typeof normalizedFilters>;
  try { filters = scopedFilters(staff, normalizedFilters(body.data.audience)); }
  catch (error) { res.status(403).json({ error: error instanceof Error ? error.message : "Ungültige Zielgruppe." }); return; }
  if (filters.ageFrom !== null && filters.ageTo !== null && filters.ageFrom > filters.ageTo) {
    res.status(400).json({ error: "Das Mindestalter darf nicht über dem Höchstalter liegen." }); return;
  }
  try { if (filters.studioId !== null) await audienceCounts(staff.organizationId, filters); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Ungültige Zielgruppe." }); return; }
  const [row] = await db.insert(marketingCampaignsTable).values({
    organizationId: staff.organizationId, createdByStaffId: staff.id,
    headline: body.data.headline.trim(), bodyText: body.data.bodyText.trim(),
    imagePath: body.data.imagePath, audienceFilters: filters,
  }).returning();
  res.status(201).json(CreateMarketingCampaignResponse.parse(campaignResponse(row, trustedOrigin(req))));
});

router.get("/marketing/audience-count", async (req, res): Promise<void> => {
  const staff = await getStaff(req, res);
  if (!staff) return;
  const query = GetMarketingAudienceCountQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Ungültige Zielgruppenfilter." }); return; }
  try {
    const filters = scopedFilters(staff, normalizedFilters({
      gender: query.data.gender, ageFrom: query.data.ageFrom ?? null, ageTo: query.data.ageTo ?? null,
      city: query.data.city ?? null, studioId: query.data.studioId ?? null,
    }));
    const result = await audienceCounts(staff.organizationId, filters);
    res.json(GetMarketingAudienceCountResponse.parse(result));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Zielgruppe konnte nicht ausgewertet werden." });
  }
});

router.get("/marketing/onesignal/recipients", async (req, res): Promise<void> => {
  const staff = await getStaff(req, res);
  if (!staff) return;
  let filters: ReturnType<typeof normalizedFilters>;
  try { filters = scopedFilters(staff, normalizedFilters({})); }
  catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : "Zugriff auf diese Empfänger ist nicht erlaubt." });
    return;
  }
  const conditions = [
    ...filterConditions(staff.organizationId, filters),
    or(eq(membersTable.marketingConsent, 1), eq(membersTable.smsConsent, 1)),
  ];
  const recipients = await db.select({
    id: membersTable.id,
    fullName: membersTable.fullName,
    phone: membersTable.phone,
    marketingConsent: membersTable.marketingConsent,
    smsConsent: membersTable.smsConsent,
  }).from(membersTable)
    .innerJoin(studiosTable, eq(studiosTable.id, membersTable.studioId))
    .where(and(...conditions))
    .orderBy(asc(membersTable.id))
    .limit(MAX_AUDIENCE + 1);
  if (recipients.length > MAX_AUDIENCE) {
    res.status(413).json({ error: `Mehr als ${MAX_AUDIENCE} eingeloggte Empfänger vorhanden. Bitte Studio oder Auswahl eingrenzen.` });
    return;
  }
  const pushRecipientIds = recipients.filter((recipient) => recipient.marketingConsent === 1).map((recipient) => recipient.id);
  const subscriptions = pushRecipientIds.length
    ? await db.select({
        memberId: memberPushSubscriptionsTable.memberId,
        subscriptionId: memberPushSubscriptionsTable.subscriptionId,
      }).from(memberPushSubscriptionsTable)
        .where(inArray(memberPushSubscriptionsTable.memberId, pushRecipientIds))
    : [];
  const pushCounts = new Map<number, number>();
  for (const subscription of subscriptions) {
    pushCounts.set(subscription.memberId, (pushCounts.get(subscription.memberId) ?? 0) + 1);
  }
  res.json(ListOneSignalMarketingRecipientsResponse.parse(recipients.map((recipient) => ({
    ...recipient,
    smsEligible: isSmsMarketingEligible(recipient),
    pushSubscriptionCount: recipient.marketingConsent === 1 ? pushCounts.get(recipient.id) ?? 0 : 0,
  }))));
});

router.post("/marketing/onesignal/send", async (req, res): Promise<void> => {
  const staff = await requirePaidStaff(req, res);
  if (!staff) return;
  const subscription = await subscriptionState(staff.organizationId);
  if (process.env.NODE_ENV !== "production" && subscription.status === "test_access") {
    res.status(403).json({ error: "In der kostenlosen Marketing-Vorschau sind echte OneSignal-Nachrichten deaktiviert." });
    return;
  }
  const body = SendOneSignalMarketingMessageBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Bitte Empfänger, Nachricht und Versandkanal prüfen." });
    return;
  }
  let filters: ReturnType<typeof normalizedFilters>;
  try { filters = scopedFilters(staff, normalizedFilters({})); }
  catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : "Zugriff auf diese Empfänger ist nicht erlaubt." });
    return;
  }
  const conditions = [
    ...filterConditions(staff.organizationId, filters),
    inArray(membersTable.id, body.data.memberIds),
  ];
  const selected = await db.select({
    id: membersTable.id,
    fullName: membersTable.fullName,
    phone: membersTable.phone,
    marketingConsent: membersTable.marketingConsent,
    smsConsent: membersTable.smsConsent,
  }).from(membersTable)
    .innerJoin(studiosTable, eq(studiosTable.id, membersTable.studioId))
    .where(and(...conditions));
  if (selected.length !== body.data.memberIds.length) {
    res.status(409).json({ error: "Die Auswahl hat sich geändert oder enthält keine aktuell eingewilligten Mitglieder. Bitte Empfängerliste aktualisieren." });
    return;
  }
  const smsRequested = body.data.channel === "sms" || body.data.channel === "both";
  const pushRequested = body.data.channel === "push" || body.data.channel === "both";
  const smsConsentedMembers = selected.filter((recipient) => recipient.smsConsent === 1);
  const pushConsentedMembers = selected.filter((recipient) => recipient.marketingConsent === 1);
  const smsPhones = smsRequested ? buildSmsMarketingPhoneNumbers(smsConsentedMembers) : [];
  const pushConsentedIds = buildPushMarketingMemberIds(pushConsentedMembers);
  const pushSubscriptions = pushRequested
    && pushConsentedIds.length
    ? await db.select({
        memberId: memberPushSubscriptionsTable.memberId,
        subscriptionId: memberPushSubscriptionsTable.subscriptionId,
      }).from(memberPushSubscriptionsTable)
        .where(inArray(memberPushSubscriptionsTable.memberId, pushConsentedIds))
    : [];
  const pushSubscriptionIds = [...new Set(pushSubscriptions.map((item) => item.subscriptionId))];
  if (!smsPhones.length && !pushSubscriptionIds.length) {
    res.status(409).json({ error: "Für die Auswahl gibt es keine erreichbare Nummer mit SMS-Einwilligung und kein registriertes Push-Gerät mit Marketing-Einwilligung." });
    return;
  }
  const readiness = await closurePushReadiness();
  if (readiness) {
    res.status(502).json({ error: readiness });
    return;
  }
  const smsResult = smsRequested
    ? smsPhones.length
      ? await submitOneSignal({
          app_id: ONESIGNAL_APP_ID,
          include_phone_numbers: smsPhones,
          target_channel: "sms",
          contents: { en: body.data.message.trim() },
          idempotency_key: body.data.smsIdempotencyKey,
        }, "sms")
      : { id: null, error: "Keine ausgewählte Nummer hat eine aktive SMS-Einwilligung und eine gültige internationale Telefonnummer." }
    : { id: null, error: null };
  const pushResult = pushRequested
    ? pushSubscriptionIds.length
      ? await submitOneSignal({
          app_id: ONESIGNAL_APP_ID,
          include_subscription_ids: pushSubscriptionIds,
          target_channel: "push",
          headings: { en: "Nachricht von deinem Studio" },
          contents: { en: body.data.message.trim() },
          idempotency_key: body.data.pushIdempotencyKey,
        }, "push")
      : { id: null, error: "Für die Auswahl sind keine OneSignal-Push-Geräte registriert." }
    : { id: null, error: null };
  const smsSucceeded = !smsRequested || !!smsResult.id;
  const pushSucceeded = !pushRequested || !!pushResult.id;
  const anySent = !!smsResult.id || !!pushResult.id;
  const skippedSmsCount = smsRequested ? selected.length - smsPhones.length : 0;
  const skippedPushCount = pushRequested
    ? selected.length - new Set(pushSubscriptions.map((item) => item.memberId)).size
    : 0;
  const status = !anySent ? "failed"
    : smsSucceeded && pushSucceeded && skippedSmsCount === 0 && skippedPushCount === 0 ? "sent"
      : "partial";
  res.json(SendOneSignalMarketingMessageResponse.parse({
    selectedCount: selected.length,
    smsTargetCount: smsPhones.length,
    pushTargetCount: pushSubscriptionIds.length,
    skippedSmsCount,
    skippedPushCount,
    smsMessageId: smsResult.id,
    pushMessageId: pushResult.id,
    status,
    smsError: smsResult.error,
    pushError: pushResult.error,
  }));
});

router.post("/marketing/uploads/request-url", async (req, res): Promise<void> => {
  const staff = await getStaff(req, res);
  if (!staff) return;
  const body = RequestMarketingImageUploadBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Bitte ein gültiges Bild bis 5 MB auswählen." }); return; }
  try {
    const upload = await createMarketingImageUpload(staff.organizationId);
    res.json(RequestMarketingImageUploadResponse.parse(upload));
  } catch (error) {
    req.log.error({ err: error }, "Marketing image upload URL failed");
    res.status(500).json({ error: "Der Bild-Upload konnte nicht vorbereitet werden." });
  }
});

router.get("/marketing/api-key", async (req, res): Promise<void> => {
  const staff = await getStaff(req, res);
  if (!staff) return;
  const approval = await getApprovedApiRequest(staff.organizationId, "marketing");
  const [row] = await db.select().from(marketingApiKeysTable)
    .where(eq(marketingApiKeysTable.organizationId, staff.organizationId)).limit(1);
  const active = !!row && !row.revokedAt && !!approval?.reviewedAt &&
    row.createdAt >= approval.reviewedAt && (await subscriptionState(staff.organizationId)).active;
  res.json(GetMarketingApiKeyResponse.parse({
    active, keyPrefix: active ? row?.keyPrefix ?? null : null,
    createdAt: active ? row?.createdAt.toISOString() ?? null : null,
    lastUsedAt: active ? row?.lastUsedAt?.toISOString() ?? null : null,
  }));
});

router.post("/marketing/api-key", async (req, res): Promise<void> => {
  const staff = await getStaff(req, res);
  if (!staff) return;
  const approval = await getApprovedApiRequest(staff.organizationId, "marketing");
  if (!approval) { res.status(403).json({ error: "Für die Marketing-API ist noch kein Zugriff freigegeben." }); return; }
  if (!isOrganizationAdmin(staff) && approval.requestedByStaffId !== staff.id) {
    res.status(403).json({ error: "Nur die antragstellende Person oder die Bezirksleitung kann den Schlüssel verwalten." }); return;
  }
  if (!(await subscriptionState(staff.organizationId)).active) { res.status(403).json({ error: "Ein aktives Marketing-Abonnement ist erforderlich." }); return; }
  const secret = `fmk_live_${randomBytes(32).toString("base64url")}`;
  const keyPrefix = secret.slice(0, 16);
  await db.insert(marketingApiKeysTable).values({
    organizationId: staff.organizationId, keyPrefix, keyHash: hash(secret), revokedAt: null,
  }).onConflictDoUpdate({
    target: marketingApiKeysTable.organizationId,
    set: { keyPrefix, keyHash: hash(secret), createdAt: new Date(), lastUsedAt: null, revokedAt: null },
  });
  res.json(RotateMarketingApiKeyResponse.parse({ key: secret, keyPrefix }));
});

async function externalOrganization(req: Request, res: Response) {
  const parsed = GetExternalMarketingAudienceCountHeader.safeParse({ "X-Fiudia-Marketing-Key": req.get("X-Fiudia-Marketing-Key") });
  if (!parsed.success) { res.status(401).json({ error: "API-Schlüssel ungültig." }); return null; }
  const key = parsed.data["X-Fiudia-Marketing-Key"];
  const prefix = key.slice(0, 16);
  const [row] = await db.select().from(marketingApiKeysTable)
    .where(and(eq(marketingApiKeysTable.keyPrefix, prefix), isNull(marketingApiKeysTable.revokedAt))).limit(1);
  if (!row || !(await hasCurrentApprovedApiAccess(row.organizationId, "marketing", row.createdAt))) {
    res.status(401).json({ error: "API-Schlüssel ungültig oder Zugriff nicht freigegeben." }); return null;
  }
  const candidate = Buffer.from(hash(key), "hex");
  const expected = Buffer.from(row?.keyHash ?? "0".repeat(64), "hex");
  if (!row || candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    res.status(401).json({ error: "API-Schlüssel ungültig." }); return null;
  }
  const now = Date.now();
  const rate = apiRateLimits.get(prefix);
  if (rate && now - rate.started < 60_000 && rate.count >= 60) {
    res.status(429).json({ error: "Zu viele Anfragen. Bitte später erneut versuchen." }); return null;
  }
  if (!rate || now - rate.started >= 60_000) apiRateLimits.set(prefix, { started: now, count: 1 });
  else rate.count += 1;
  await db.update(marketingApiKeysTable).set({ lastUsedAt: new Date() }).where(eq(marketingApiKeysTable.id, row.id));
  return row.organizationId;
}

router.get("/external/marketing/audience-count", async (req, res): Promise<void> => {
  const organizationId = await externalOrganization(req, res);
  if (!organizationId) return;
  if (!(await subscriptionState(organizationId)).active) { res.status(403).json({ error: "Das Marketing-Abonnement ist nicht aktiv." }); return; }
  const query = GetExternalMarketingAudienceCountQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Ungültige Zielgruppenfilter." }); return; }
  try {
    const result = await audienceCounts(organizationId, normalizedFilters({
      gender: query.data.gender, ageFrom: query.data.ageFrom ?? null, ageTo: query.data.ageTo ?? null,
      city: query.data.city ?? null, studioId: query.data.studioId ?? null,
    }));
    res.json(GetExternalMarketingAudienceCountResponse.parse(result));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Abfrage konnte nicht ausgeführt werden." });
  }
});

router.get("/marketing/images/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(404).end(); return; }
  const [campaign] = await db.select({ imagePath: marketingCampaignsTable.imagePath })
    .from(marketingCampaignsTable).where(eq(marketingCampaignsTable.id, id)).limit(1);
  const file = campaign ? await getMarketingImageFile(campaign.imagePath) : null;
  if (!file) { res.status(404).end(); return; }
  await pipeMarketingImage(file, res);
});

router.get("/marketing/unsubscribe/:token", async (req, res): Promise<void> => {
  const token = req.params.token;
  if (typeof token !== "string" || token.length < 32 || token.length > 200) {
    res.status(400).json(UnsubscribeFromMarketingResponse.parse({ unsubscribed: false })); return;
  }
  const [row] = await db.select().from(marketingUnsubscribeTokensTable)
    .where(eq(marketingUnsubscribeTokensTable.tokenHash, hash(token))).limit(1);
  if (!row) { res.status(404).json({ error: "Abmeldelink ungültig oder bereits entfernt." }); return; }
  await db.update(membersTable).set({ marketingConsent: 0, marketingConsentAt: null })
    .where(eq(membersTable.id, row.memberId));
  await db.update(marketingUnsubscribeTokensTable).set({ usedAt: new Date() })
    .where(eq(marketingUnsubscribeTokensTable.id, row.id));
  res.json(UnsubscribeFromMarketingResponse.parse({ unsubscribed: true }));
});

router.post("/marketing/campaigns/:id/send", async (req, res): Promise<void> => {
  const staff = await requirePaidStaff(req, res);
  if (!staff) return;
  const subscription = await subscriptionState(staff.organizationId);
  if (process.env.NODE_ENV !== "production" && subscription.status === "test_access") {
    res.status(403).json({ error: "Bei der kostenlosen Vorschau-Testfreigabe ist der reale E-Mail-Versand deaktiviert." });
    return;
  }
  const params = SendMarketingCampaignParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Ungültige Kampagne." }); return; }
  const [campaign] = await db.select().from(marketingCampaignsTable)
    .where(and(eq(marketingCampaignsTable.id, params.data.id), eq(marketingCampaignsTable.organizationId, staff.organizationId))).limit(1);
  if (!campaign) { res.status(404).json({ error: "Kampagne nicht gefunden." }); return; }
  let filters: ReturnType<typeof normalizedFilters>;
  try { filters = scopedFilters(staff, normalizedFilters(campaign.audienceFilters)); }
  catch (error) { res.status(403).json({ error: error instanceof Error ? error.message : "Ungültige Zielgruppe." }); return; }
  const conditions = [...filterConditions(staff.organizationId, filters), eq(membersTable.marketingConsent, 1)];
  const recipients = await db.select({
    id: membersTable.id, fullName: membersTable.fullName, email: membersTable.email,
  }).from(membersTable).innerJoin(studiosTable, eq(membersTable.studioId, studiosTable.id))
    .where(and(...conditions)).orderBy(asc(membersTable.id)).limit(MAX_AUDIENCE + 1);
  if (!recipients.length) { res.status(409).json({ error: "Keine passenden Mitglieder mit dokumentierter Marketing-Einwilligung." }); return; }
  if (recipients.length > MAX_AUDIENCE) { res.status(413).json({ error: `Die Zielgruppe überschreitet das Limit von ${MAX_AUDIENCE}. Bitte enger filtern.` }); return; }
  const origin = trustedOrigin(req);
  const imageUrl = `${origin}/api/marketing/images/${campaign.id}`;
  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    const [prior] = await db.select().from(marketingDeliveriesTable).where(and(
      eq(marketingDeliveriesTable.campaignId, campaign.id), eq(marketingDeliveriesTable.memberId, recipient.id),
    )).limit(1);
    if (prior?.status === "sent") continue;
    const unsubscribeToken = randomBytes(32).toString("base64url");
    await db.insert(marketingUnsubscribeTokensTable).values({
      memberId: recipient.id, tokenHash: hash(unsubscribeToken),
    });
    if (prior) await db.update(marketingDeliveriesTable).set({ status: "pending", errorMessage: null })
      .where(eq(marketingDeliveriesTable.id, prior.id));
    else await db.insert(marketingDeliveriesTable).values({ campaignId: campaign.id, memberId: recipient.id, status: "pending" });
    const unsubscribeUrl = `${origin}/api/marketing/unsubscribe/${unsubscribeToken}`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto"><img src="${imageUrl}" alt="" style="display:block;width:100%;height:auto"><h1>${escapeHtml(campaign.headline)}</h1><p>${escapeHtml(campaign.bodyText).replaceAll("\n", "<br>")}</p><p style="font-size:12px;color:#777">Sie erhalten diese Nachricht, weil Sie Marketing-E-Mails Ihres Studios zugestimmt haben. <a href="${unsubscribeUrl}">Abmelden</a></p></div>`;
    try {
      const response = await resendRequest("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: process.env.FIUDIA_EMAIL_FROM ?? "Fiudia <mail@fiudia.com>",
          to: [recipient.email], subject: campaign.headline, html,
          headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const result = await response.json().catch(() => ({})) as { id?: string; message?: string };
      if (!response.ok) throw new Error(result.message || `Email provider returned ${response.status}`);
      await db.update(marketingDeliveriesTable).set({ status: "sent", providerMessageId: result.id ?? null, sentAt: new Date() })
        .where(and(eq(marketingDeliveriesTable.campaignId, campaign.id), eq(marketingDeliveriesTable.memberId, recipient.id)));
      sent += 1;
    } catch (error) {
      await db.update(marketingDeliveriesTable).set({ status: "failed", errorMessage: error instanceof Error ? error.message.slice(0, 300) : "Email send failed" })
        .where(and(eq(marketingDeliveriesTable.campaignId, campaign.id), eq(marketingDeliveriesTable.memberId, recipient.id)));
      failed += 1;
    }
  }
  const [totalSent] = await db.select({ count: count() }).from(marketingDeliveriesTable).where(and(
    eq(marketingDeliveriesTable.campaignId, campaign.id), eq(marketingDeliveriesTable.status, "sent"),
  ));
  await db.update(marketingCampaignsTable).set({
    status: Number(totalSent.count) > 0 ? "sent" : "draft",
    recipientCount: Number(totalSent.count),
    sentAt: Number(totalSent.count) > 0 ? new Date() : null,
    updatedAt: new Date(),
  }).where(eq(marketingCampaignsTable.id, campaign.id));
  res.json(SendMarketingCampaignResponse.parse({ campaignId: campaign.id, recipientCount: sent, failedCount: failed, status: "sent" }));
});

router.get("/external/marketing/docs", (req, res) => {
  res.type("html").send(`<!doctype html><html lang="de"><meta charset="utf-8"><title>Fiudia Marketing-API</title><body style="font:16px system-ui;max-width:760px;margin:48px auto;padding:0 20px;color:#24223a"><h1>Fiudia Marketing-API</h1><p>Die Agentur-API liefert ausschließlich anonyme Zielgruppenzahlen. Sie gibt keine Namen, E-Mail-Adressen oder einzelnen Mitgliederdaten zurück.</p><h2>Endpunkt</h2><pre>GET /api/external/marketing/audience-count</pre><h2>Authentifizierung</h2><pre>X-Fiudia-Marketing-Key: fmk_live_…</pre><h2>Erlaubte Filter</h2><p><code>gender=all|male|female|diverse</code>, <code>ageFrom</code>, <code>ageTo</code>, <code>city</code>, <code>studioId</code>.</p><h2>Beispiel</h2><pre>GET /api/external/marketing/audience-count?gender=female&amp;ageFrom=25&amp;ageTo=44&amp;city=Berlin</pre><p>Die Antwort enthält nur die Trefferzahl und die Zahl der E-Mail-Empfänger mit dokumentierter Einwilligung. Schlüssel können durch die Bezirksleitung rotiert werden.</p></body></html>`);
});

export default router;
