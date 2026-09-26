import { Router, type IRouter } from "express";
import healthRouter from "./health";
import portalRouter from "./portal";
import teamRouter from "./team";

const router: IRouter = Router();

router.use(healthRouter);
router.use(portalRouter);
router.use(teamRouter);

export default router;
