import { and, eq } from "drizzle-orm";
import type { RequestHandler } from "express";
import { db, organizationModulesTable } from "@workspace/db";
import {
  getRequestUserId,
  getStaffContext,
} from "./fiudia-access";

export const MODULE_KEYS = ["members", "courses", "pulse", "team"] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

const moduleKeySet: ReadonlySet<string> = new Set(MODULE_KEYS);

export function isModuleKey(value: string): value is ModuleKey {
  return moduleKeySet.has(value);
}

export async function isModuleEnabled(
  organizationId: number,
  key: ModuleKey,
  database: Pick<typeof db, "select"> = db,
): Promise<boolean> {
  const [override] = await database
    .select({ enabled: organizationModulesTable.enabled })
    .from(organizationModulesTable)
    .where(
      and(
        eq(organizationModulesTable.organizationId, organizationId),
        eq(organizationModulesTable.key, key),
      ),
    )
    .limit(1);
  // No stored override means enabled, preserving existing organization behavior.
  if (!override) return true;
  return override.enabled === 1;
}

export function requireModule(key: ModuleKey): RequestHandler {
  return async (req, res, next): Promise<void> => {
    const userId = getRequestUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Bitte melde dich an." });
      return;
    }
    const staff = await getStaffContext(userId);
    if (!staff || !(await isModuleEnabled(staff.organizationId, key))) {
      res.status(403).json({ error: "Dieses Modul ist für deine Organisation nicht aktiviert." });
      return;
    }
    next();
  };
}