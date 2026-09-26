import { eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  ListModulesResponse,
  UpdateModuleBody,
  UpdateModuleParams,
  UpdateModuleResponse,
} from "@workspace/api-zod";
import { db, organizationModulesTable } from "@workspace/db";
import {
  getRequestUserId,
  getStaffContext,
  type StaffContext,
} from "../lib/fiudia-access";
import {
  MODULE_KEYS,
  type ModuleKey,
} from "../lib/module-access";

const MODULE_TITLES: Record<ModuleKey, string> = {
  members: "Mitglieder",
  courses: "Kurse",
  pulse: "Pulse",
  team: "Team",
};

type ModulesDependencies = {
  database: typeof db;
  userIdFromRequest: (req: Request) => string | null;
};

export function createModulesRouter(
  dependencies: Partial<ModulesDependencies> = {},
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

  router.get("/modules", async (req, res): Promise<void> => {
    const staff = await requireStaff(req, res);
    if (!staff) return;

    const overrides = await database
      .select({
        key: organizationModulesTable.key,
        enabled: organizationModulesTable.enabled,
      })
      .from(organizationModulesTable)
      .where(eq(organizationModulesTable.organizationId, staff.organizationId));
    const enabledByKey = new Map(
      overrides.map((item) => [item.key, item.enabled === 1]),
    );
    res.json(
      ListModulesResponse.parse(
        MODULE_KEYS.map((key) => ({
          key,
          title: MODULE_TITLES[key],
          enabled: enabledByKey.get(key) ?? true,
        })),
      ),
    );
  });

  router.patch("/modules/:key", async (req, res): Promise<void> => {
    const staff = await requireStaff(req, res);
    if (!staff) return;
    if (staff.role !== "district_manager") {
      res.status(403).json({ error: "Nur Bezirksleitungen können Module verwalten." });
      return;
    }

    const params = UpdateModuleParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const body = UpdateModuleBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const key = params.data.key;
    await database
      .insert(organizationModulesTable)
      .values({
        organizationId: staff.organizationId,
        key,
        enabled: body.data.enabled ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: [
          organizationModulesTable.organizationId,
          organizationModulesTable.key,
        ],
        set: { enabled: body.data.enabled ? 1 : 0 },
      });

    res.json(
      UpdateModuleResponse.parse({
        key,
        title: MODULE_TITLES[key],
        enabled: body.data.enabled,
      }),
    );
  });

  return router;
}

export default createModulesRouter();