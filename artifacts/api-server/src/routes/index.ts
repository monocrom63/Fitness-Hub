import { Router, type IRouter } from "express";
import healthRouter from "./health";
import portalRouter from "./portal";
import pulseRouter from "./pulse";
import teamRouter from "./team";

const router: IRouter = Router();

router.use(healthRouter);
router.use(portalRouter);
router.use(pulseRouter);
router.use(teamRouter);

export default router;
