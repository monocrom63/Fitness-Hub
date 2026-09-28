import { Router, type IRouter } from "express";
import healthRouter from "./health";
import portalRouter from "./portal";
import pulseRouter from "./pulse";
import teamRouter from "./team";
import modulesRouter from "./modules";
import memberAppRouter from "./member-app";
import memberInvitationsRouter from "./member-invitations";
import courseBookingsRouter from "./course-bookings";
import courseEditsRouter from "./course-edits";
import roomAssetsRouter from "./room-assets";
import trainerAbsencesRouter from "./trainer-absences";
import { requireModule } from "../lib/module-access";

const router: IRouter = Router();

router.use(healthRouter);
router.use(modulesRouter);
router.use("/members", requireModule("members"));
router.use("/check-ins", requireModule("members"));
router.use("/courses/:id/bookings", requireModule("members"));
router.use("/courses", requireModule("courses"));
router.use("/trainer-absences", requireModule("courses"));
router.use("/pulse", requireModule("pulse"));
router.use("/team", requireModule("team"));
router.use(roomAssetsRouter);
router.use(trainerAbsencesRouter);
router.use(portalRouter);
router.use(courseBookingsRouter);
router.use(courseEditsRouter);
router.use(pulseRouter);
router.use(teamRouter);
router.use(memberAppRouter);
router.use(memberInvitationsRouter);

export default router;
