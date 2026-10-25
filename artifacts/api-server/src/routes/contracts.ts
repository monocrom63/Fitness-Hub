import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import {
  contractSettingsTable,
  db,
  memberContractsTable,
  membershipPlansTable,
  membersTable,
  studiosTable,
} from "@workspace/db";
import { getRequestUserId, getStaffContext } from "../lib/fiudia-access";
import { linkedMember } from "./member-app";
import { resendRequest } from "../lib/resend-client";
import { getStripeClient } from "../lib/stripe-client";
import { DEFAULT_CONTRACT_TERMS } from "../lib/default-contract-terms";

const router: IRouter = Router();
const settingsSchema = z.object({
  legalName: z.string().max(200),
  legalAddress: z.string().max(500),
  contactEmail: z.email(),
  contactPhone: z.string().max(40),
  termsText: z.string().max(50000),
  enrollmentFeeCents: z.number().int().min(0),
  membershipCardFeeCents: z.number().int().min(0),
  paymentDueDay: z.number().int().min(1).max(28),
  plans: z.array(z.object({
    id: z.number().int().nullable().optional(),
    name: z.string().min(2).max(80),
    durationMonths: z.number().int().min(1).max(1200),
    monthlyPriceCents: z.number().int().min(0),
    semiannualDiscountPercent: z.number().int().min(0).max(100),
    annualDiscountPercent: z.number().int().min(0).max(100),
  })),
});
const settingsPatchSchema = settingsSchema.partial().refine(
  data => Object.keys(data).length > 0,
  "Mindestens ein Einstellungsbereich muss übermittelt werden.",
);
const signatureSchema = z.object({
  signatureName: z.string().min(2).max(160),
  acceptTerms: z.literal(true),
});

router.get("/v1/public/contract-terms", (_req, res): void => {
  res.json({
    title: "Allgemeine Geschäftsbedingungen",
    termsText: DEFAULT_CONTRACT_TERMS,
    termsVersion: 1,
    isTemplate: true,
  });
});

function jsonContract(row: typeof memberContractsTable.$inferSelect) {
  return {
    id: row.id,
    status: row.status as "draft" | "signed",
    contractSnapshot: row.contractSnapshot as Record<string, unknown>,
    termsVersion: row.termsVersion,
    signatureName: row.signatureName,
    signedAt: row.signedAt?.toISOString() ?? null,
    emailStatus: row.emailStatus as "not_sent" | "sent" | "failed",
    pdfUrl: `/api/v1/contracts/${row.id}/pdf`,
  };
}

async function pdfBytes(snapshot: Record<string, unknown>, signatureName?: string | null, signedAt?: Date | null) {
  const doc = new PDFDocument({ size: "A4", margin: 54 });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const logoPath = path.resolve(process.cwd(), "../fiudia/public/logo.svg");
  const logo = await readFile(logoPath, "utf8");
  SVGtoPDF(doc, logo, 54, 40, { width: 120, height: 42 });
  doc.moveDown(4);
  doc.fontSize(22).fillColor("#14243a").text("Mitgliedsvertrag");
  doc.moveDown(1);
  doc.fontSize(11).fillColor("#17212f");
  const fields = [
    ["Mitglied", snapshot.memberName],
    ["E-Mail", snapshot.email],
    ["Geburtsdatum", snapshot.birthDate],
    ["Adresse", snapshot.address],
    ["Mitgliedschaft", snapshot.membershipType],
    ["Vertragsbeginn", snapshot.contractStart],
    ["Laufzeit", snapshot.contractDurationMonths ? `${snapshot.contractDurationMonths} Monate` : "Unbefristet"],
    ["Ruhezeit", snapshot.restPeriodStart || snapshot.restPeriodEnd
      ? `${snapshot.restPeriodStart ?? "—"} bis ${snapshot.restPeriodEnd ?? "—"}` : "Keine"],
    ["Zahlungsintervall", snapshot.billingInterval],
    ["Monatsbeitrag", snapshot.monthlyPrice],
    ["Beitrag je Abbuchung", snapshot.amountPerPayment],
  ];
  for (const [label, value] of fields) {
    doc.font("Helvetica-Bold").text(`${label}: `, { continued: true });
    doc.font("Helvetica").text(String(value ?? "—"));
  }
  doc.moveDown(1);
  doc.font("Helvetica-Bold").text("Vertragsbedingungen");
  doc.moveDown(0.35);
  doc.font("Helvetica").text(String(snapshot.termsText ?? ""), { lineGap: 3 });
  doc.moveDown(1);
  if (signatureName && signedAt) {
    doc.font("Helvetica-Bold").text("Elektronisch bestätigt");
    doc.font("Helvetica").text(`${signatureName} · ${signedAt.toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}`);
  }
  doc.moveDown(1);
  doc.fontSize(9).fillColor("#64748b").text(
    `${snapshot.legalName ?? ""}\n${snapshot.legalAddress ?? ""}\n${snapshot.contactEmail ?? ""} · ${snapshot.contactPhone ?? ""}`,
  );
  doc.end();
  return result;
}

async function memberContract(req: Request, res: import("express").Response, contractId: number) {
  const userId = getRequestUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Bitte melde dich an." });
    return null;
  }
  const member = await linkedMember(userId);
  if (!member) {
    res.status(403).json({ error: "Es ist kein Mitgliedskonto verknüpft." });
    return null;
  }
  const [contract] = await db.select().from(memberContractsTable)
    .where(and(eq(memberContractsTable.id, contractId), eq(memberContractsTable.memberId, member.id)))
    .limit(1);
  if (!contract) {
    res.status(404).json({ error: "Vertrag nicht gefunden." });
    return null;
  }
  return contract;
}

router.get("/v1/contracts/settings", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Bitte melde dich an." }); return; }
  const staff = await getStaffContext(userId);
  if (!staff || staff.role === "studio_employee") {
    res.status(403).json({ error: "Nur Studio- oder Bezirksleitungen dürfen Vertragsdaten verwalten." });
    return;
  }
  const [settings] = await db.select().from(contractSettingsTable)
    .where(eq(contractSettingsTable.organizationId, staff.organizationId)).limit(1);
  const plans = await db.select().from(membershipPlansTable)
    .where(eq(membershipPlansTable.organizationId, staff.organizationId));
  res.json({
    legalName: settings?.legalName ?? "",
    legalAddress: settings?.legalAddress ?? "",
    contactEmail: settings?.contactEmail ?? "",
    contactPhone: settings?.contactPhone ?? "",
    termsText: settings?.termsText || DEFAULT_CONTRACT_TERMS,
    termsVersion: settings?.termsVersion ?? 1,
    enrollmentFeeCents: settings?.enrollmentFeeCents ?? 0,
    membershipCardFeeCents: settings?.membershipCardFeeCents ?? 0,
    paymentDueDay: settings?.paymentDueDay ?? 1,
    plans: plans.map((plan) => ({
      id: plan.id, name: plan.name, durationMonths: plan.durationMonths,
      monthlyPriceCents: plan.monthlyPriceCents,
      semiannualDiscountPercent: plan.semiannualDiscountPercent,
      annualDiscountPercent: plan.annualDiscountPercent,
      active: Boolean(plan.active),
    })),
  });
});

router.put("/v1/contracts/settings", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Bitte melde dich an." }); return; }
  const staff = await getStaffContext(userId);
  if (!staff || staff.role === "studio_employee") {
    res.status(403).json({ error: "Nur Studio- oder Bezirksleitungen dürfen Vertragsdaten verwalten." });
    return;
  }
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const data = parsed.data;
  await db.transaction(async (tx) => {
    const [existing] = await tx.select({ termsVersion: contractSettingsTable.termsVersion })
      .from(contractSettingsTable).where(eq(contractSettingsTable.organizationId, staff.organizationId)).limit(1);
    const termsVersion = existing ? existing.termsVersion + 1 : 1;
    await tx.insert(contractSettingsTable).values({
      organizationId: staff.organizationId,
      legalName: data.legalName.trim(),
      legalAddress: data.legalAddress.trim(),
      contactEmail: data.contactEmail.trim().toLowerCase(),
      contactPhone: data.contactPhone.trim(),
      termsText: data.termsText.trim(),
      termsVersion,
      enrollmentFeeCents: data.enrollmentFeeCents,
      membershipCardFeeCents: data.membershipCardFeeCents,
      paymentDueDay: data.paymentDueDay,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: contractSettingsTable.organizationId,
      set: {
        legalName: data.legalName.trim(),
        legalAddress: data.legalAddress.trim(),
        contactEmail: data.contactEmail.trim().toLowerCase(),
        contactPhone: data.contactPhone.trim(),
        termsText: data.termsText.trim(),
        termsVersion,
        enrollmentFeeCents: data.enrollmentFeeCents,
        membershipCardFeeCents: data.membershipCardFeeCents,
        paymentDueDay: data.paymentDueDay,
        updatedAt: new Date(),
      },
    });
    for (const plan of data.plans) {
      if (plan.id) {
        await tx.update(membershipPlansTable).set({
          name: plan.name.trim(), durationMonths: plan.durationMonths,
          monthlyPriceCents: plan.monthlyPriceCents,
          semiannualDiscountPercent: plan.semiannualDiscountPercent,
          annualDiscountPercent: plan.annualDiscountPercent,
        }).where(and(eq(membershipPlansTable.id, plan.id), eq(membershipPlansTable.organizationId, staff.organizationId)));
      } else {
        await tx.insert(membershipPlansTable).values({
          organizationId: staff.organizationId, name: plan.name.trim(),
          durationMonths: plan.durationMonths, monthlyPriceCents: plan.monthlyPriceCents,
          semiannualDiscountPercent: plan.semiannualDiscountPercent,
          annualDiscountPercent: plan.annualDiscountPercent,
        }).onConflictDoNothing();
      }
    }
  });
  const [settings] = await db.select().from(contractSettingsTable)
    .where(eq(contractSettingsTable.organizationId, staff.organizationId)).limit(1);
  const plans = await db.select().from(membershipPlansTable)
    .where(eq(membershipPlansTable.organizationId, staff.organizationId));
  res.json({
    legalName: settings.legalName, legalAddress: settings.legalAddress,
    contactEmail: settings.contactEmail, contactPhone: settings.contactPhone,
    termsText: settings.termsText, termsVersion: settings.termsVersion,
    enrollmentFeeCents: settings.enrollmentFeeCents,
    membershipCardFeeCents: settings.membershipCardFeeCents,
    paymentDueDay: settings.paymentDueDay,
    plans: plans.map((plan) => ({
      id: plan.id, name: plan.name, durationMonths: plan.durationMonths,
      monthlyPriceCents: plan.monthlyPriceCents,
      semiannualDiscountPercent: plan.semiannualDiscountPercent,
      annualDiscountPercent: plan.annualDiscountPercent,
      active: Boolean(plan.active),
    })),
  });
});

router.patch("/v1/contracts/settings", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Bitte melde dich an." }); return; }
  const staff = await getStaffContext(userId);
  if (!staff || staff.role === "studio_employee") {
    res.status(403).json({ error: "Nur Studio- oder Bezirksleitungen dürfen Vertragsdaten verwalten." });
    return;
  }
  const parsed = settingsPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const data = parsed.data;
  await db.transaction(async tx => {
    const [existing] = await tx.select({
      termsText: contractSettingsTable.termsText,
      termsVersion: contractSettingsTable.termsVersion,
    }).from(contractSettingsTable)
      .where(eq(contractSettingsTable.organizationId, staff.organizationId)).limit(1);
    const termsText = data.termsText?.trim();
    const termsVersion = existing
      ? existing.termsVersion + (termsText !== undefined && termsText !== existing.termsText ? 1 : 0)
      : 1;
    const settingsUpdate = {
      ...(data.legalName !== undefined ? { legalName: data.legalName.trim() } : {}),
      ...(data.legalAddress !== undefined ? { legalAddress: data.legalAddress.trim() } : {}),
      ...(data.contactEmail !== undefined ? { contactEmail: data.contactEmail.trim().toLowerCase() } : {}),
      ...(data.contactPhone !== undefined ? { contactPhone: data.contactPhone.trim() } : {}),
      ...(termsText !== undefined ? { termsText } : {}),
      ...(data.enrollmentFeeCents !== undefined ? { enrollmentFeeCents: data.enrollmentFeeCents } : {}),
      ...(data.membershipCardFeeCents !== undefined ? { membershipCardFeeCents: data.membershipCardFeeCents } : {}),
      ...(data.paymentDueDay !== undefined ? { paymentDueDay: data.paymentDueDay } : {}),
      termsVersion,
      updatedAt: new Date(),
    };
    if (existing) {
      await tx.update(contractSettingsTable).set(settingsUpdate)
        .where(eq(contractSettingsTable.organizationId, staff.organizationId));
    } else {
      await tx.insert(contractSettingsTable).values({
        organizationId: staff.organizationId,
        legalName: data.legalName?.trim() ?? "",
        legalAddress: data.legalAddress?.trim() ?? "",
        contactEmail: data.contactEmail?.trim().toLowerCase() ?? "",
        contactPhone: data.contactPhone?.trim() ?? "",
        termsText: termsText ?? "",
        termsVersion,
        enrollmentFeeCents: data.enrollmentFeeCents ?? 0,
        membershipCardFeeCents: data.membershipCardFeeCents ?? 0,
        paymentDueDay: data.paymentDueDay ?? 1,
        updatedAt: new Date(),
      });
    }
    for (const plan of data.plans ?? []) {
      if (plan.id) {
        await tx.update(membershipPlansTable).set({
          name: plan.name.trim(), durationMonths: plan.durationMonths,
          monthlyPriceCents: plan.monthlyPriceCents,
          semiannualDiscountPercent: plan.semiannualDiscountPercent,
          annualDiscountPercent: plan.annualDiscountPercent,
        }).where(and(eq(membershipPlansTable.id, plan.id), eq(membershipPlansTable.organizationId, staff.organizationId)));
      } else {
        await tx.insert(membershipPlansTable).values({
          organizationId: staff.organizationId, name: plan.name.trim(),
          durationMonths: plan.durationMonths, monthlyPriceCents: plan.monthlyPriceCents,
          semiannualDiscountPercent: plan.semiannualDiscountPercent,
          annualDiscountPercent: plan.annualDiscountPercent,
        }).onConflictDoNothing();
      }
    }
  });
  const [settings] = await db.select().from(contractSettingsTable)
    .where(eq(contractSettingsTable.organizationId, staff.organizationId)).limit(1);
  const plans = await db.select().from(membershipPlansTable)
    .where(eq(membershipPlansTable.organizationId, staff.organizationId));
  res.json({
    legalName: settings.legalName, legalAddress: settings.legalAddress,
    contactEmail: settings.contactEmail, contactPhone: settings.contactPhone,
    termsText: settings.termsText || DEFAULT_CONTRACT_TERMS,
    termsVersion: settings.termsVersion,
    enrollmentFeeCents: settings.enrollmentFeeCents,
    membershipCardFeeCents: settings.membershipCardFeeCents,
    paymentDueDay: settings.paymentDueDay,
    plans: plans.map(plan => ({
      id: plan.id, name: plan.name, durationMonths: plan.durationMonths,
      monthlyPriceCents: plan.monthlyPriceCents,
      semiannualDiscountPercent: plan.semiannualDiscountPercent,
      annualDiscountPercent: plan.annualDiscountPercent,
      active: Boolean(plan.active),
    })),
  });
});

router.get("/v1/member/contracts/current", async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Bitte melde dich an." }); return; }
  const member = await linkedMember(userId);
  if (!member) { res.status(403).json({ error: "Es ist kein Mitgliedskonto verknüpft." }); return; }
  const [existing] = await db.select().from(memberContractsTable)
    .where(eq(memberContractsTable.memberId, member.id))
    .orderBy(desc(memberContractsTable.createdAt)).limit(1);
  const [settings] = await db.select().from(contractSettingsTable)
    .where(eq(contractSettingsTable.organizationId, member.organizationId)).limit(1);
  if (existing?.status === "draft") { res.json(jsonContract(existing)); return; }
  if (existing?.status === "signed" && settings) {
    const prior = existing.contractSnapshot as Record<string, unknown>;
    const unchanged = existing.termsVersion === settings.termsVersion &&
      prior.membershipType === member.membershipType &&
      prior.billingInterval === member.billingInterval &&
      prior.contractStart === member.contractStart &&
      prior.contractDurationMonths === member.contractDurationMonths &&
      prior.restPeriodStart === member.restPeriodStart &&
      prior.restPeriodEnd === member.restPeriodEnd;
    if (unchanged) { res.json(jsonContract(existing)); return; }
  }
  if (!settings?.legalName || !settings.termsText) {
    res.status(403).json({ error: "Die Leitung muss zuerst Fiudia-Vertragsangaben und AGB im Adminbereich hinterlegen." });
    return;
  }
  const [plan] = await db.select().from(membershipPlansTable)
    .where(and(
      eq(membershipPlansTable.organizationId, member.organizationId),
      eq(membershipPlansTable.name, member.membershipType),
      eq(membershipPlansTable.active, 1),
    )).limit(1);
  if (!plan) { res.status(403).json({ error: "Für deinen Tarif ist noch kein gültiger Vertragspreis hinterlegt." }); return; }
  const discount = member.billingInterval === "annual" ? plan.annualDiscountPercent
    : member.billingInterval === "semiannual" ? plan.semiannualDiscountPercent : 0;
  const amount = Math.round(plan.monthlyPriceCents * (member.billingInterval === "annual" ? 12 : member.billingInterval === "semiannual" ? 6 : 1) * (100 - discount) / 100);
  const [contract] = await db.insert(memberContractsTable).values({
    memberId: member.id, organizationId: member.organizationId, termsVersion: settings.termsVersion,
    contractSnapshot: {
      memberName: member.fullName, email: member.email, phone: member.phone,
      birthDate: member.birthDate, address: member.address, membershipType: member.membershipType,
      contractStart: member.contractStart, contractDurationMonths: member.contractDurationMonths ?? plan.durationMonths,
      billingInterval: member.billingInterval, monthlyPrice: `${(plan.monthlyPriceCents / 100).toFixed(2)} €`,
      amountPerPayment: `${(amount / 100).toFixed(2)} €`, amountPerPaymentCents: amount,
      restPeriodStart: member.restPeriodStart, restPeriodEnd: member.restPeriodEnd,
      termsText: settings.termsText,
      legalName: settings.legalName, legalAddress: settings.legalAddress,
      contactEmail: settings.contactEmail, contactPhone: settings.contactPhone,
    },
  }).returning();
  res.status(201).json(jsonContract(contract));
});

router.get("/v1/contracts/:id/pdf", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Ungültige Vertragsnummer." }); return; }
  const contract = await memberContract(req, res, id);
  if (!contract) return;
  const pdf = await pdfBytes(contract.contractSnapshot as Record<string, unknown>, contract.signatureName, contract.signedAt);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="Fiudia-Vertrag-${id}.pdf"`);
  res.send(pdf);
});

router.post("/v1/contracts/:id/sig", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Ungültige Vertragsnummer." }); return; }
  const parsed = signatureSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Bitte bestätige die AGB und gib deinen Namen ein." }); return; }
  const contract = await memberContract(req, res, id);
  if (!contract) return;
  if (contract.status !== "draft") { res.status(409).json({ error: "Dieser Vertrag wurde bereits bestätigt." }); return; }
  const userId = getRequestUserId(req)!;
  const member = await linkedMember(userId);
  const snapshot = contract.contractSnapshot as Record<string, unknown>;
  if (member?.billingStatus === "active" && member.stripeSubscriptionId) {
    try {
      const stripe = await getStripeClient();
      const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ").toLowerCase();
      const tariff = normalize(String(snapshot.membershipType ?? ""));
      const interval = String(snapshot.billingInterval ?? "monthly");
      const intervalCount = interval === "annual" ? 12 : interval === "semiannual" ? 6 : 1;
      const expectedAmount = Number(snapshot.amountPerPaymentCents);
      const products = await stripe.products.list({ active: true, limit: 100 });
      const product = products.data.find((item) => item.metadata.fiudia_tariff === tariff)
        ?? await stripe.products.create({ name: String(snapshot.membershipType), metadata: { fiudia_tariff: tariff } });
      if (!Number.isFinite(expectedAmount)) throw new Error("Für den gewählten Tarif ist kein gültiger Preis vorhanden.");
      const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
      const existingPrice = prices.data.find((price) => price.currency === "eur" &&
        price.unit_amount === expectedAmount &&
        price.recurring?.interval === "month" &&
        price.recurring.interval_count === intervalCount);
      let targetPriceId = existingPrice?.id;
      if (!targetPriceId) {
        const createdPrice = await stripe.prices.create({
          product: product.id, currency: "eur", unit_amount: expectedAmount,
          recurring: { interval: "month", interval_count: intervalCount },
          metadata: { fiudia_tariff: tariff, fiudia_interval: interval },
        });
        targetPriceId = createdPrice.id;
      }
      const subscription = await stripe.subscriptions.retrieve(member.stripeSubscriptionId);
      const item = subscription.items.data[0];
      if (!item) throw new Error("Das Stripe-Abonnement enthält keine Position.");
      if (item.price.id !== targetPriceId) {
        await stripe.subscriptions.update(subscription.id, {
          items: [{ id: item.id, price: targetPriceId }],
          proration_behavior: "none",
        });
      }
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : "Die Tarifänderung konnte bei Stripe nicht vorgemerkt werden." });
      return;
    }
  }
  const signedAt = new Date();
  const [signed] = await db.update(memberContractsTable).set({
    status: "signed", signatureName: parsed.data.signatureName.trim(),
    signedEmail: member!.email, signedAt,
  }).where(and(eq(memberContractsTable.id, id), eq(memberContractsTable.status, "draft"))).returning();
  if (!signed) { res.status(409).json({ error: "Dieser Vertrag wurde bereits bestätigt." }); return; }
  try {
    const pdf = await pdfBytes(signed.contractSnapshot as Record<string, unknown>, signed.signatureName, signed.signedAt);
    const response = await resendRequest("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.FIUDIA_EMAIL_FROM ?? "Fiudia <mail@fiudia.com>",
        to: [member!.email],
        subject: "Dein Fiudia-Mitgliedsvertrag",
        html: "<p>Danke für deine Bestätigung. Deinen unterschriebenen Fiudia-Vertrag findest du im Anhang.</p>",
        attachments: [{ filename: `Fiudia-Vertrag-${id}.pdf`, content: pdf.toString("base64") }],
      }),
    });
    if (!response.ok) throw new Error(`Resend antwortete mit HTTP ${response.status}.`);
    await db.update(memberContractsTable).set({ emailStatus: "sent" }).where(eq(memberContractsTable.id, id));
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 500) : "E-Mail konnte nicht versendet werden.";
    await db.update(memberContractsTable).set({ emailStatus: "failed", emailFailureReason: reason }).where(eq(memberContractsTable.id, id));
  }
  const [updated] = await db.select().from(memberContractsTable).where(eq(memberContractsTable.id, id)).limit(1);
  res.json(jsonContract(updated));
});

export default router;
