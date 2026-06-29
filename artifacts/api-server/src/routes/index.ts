import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import distributorsRouter from "./distributors";
import brandsRouter from "./brands";
import dashboardRouter from "./dashboard";
import comparisonRouter from "./comparison";
import uploadsRouter from "./uploads";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(distributorsRouter);
router.use(brandsRouter);
router.use(dashboardRouter);
router.use(comparisonRouter);
router.use(uploadsRouter);

export default router;
