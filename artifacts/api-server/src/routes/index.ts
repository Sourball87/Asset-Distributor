import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import distributorsRouter from "./distributors";
import brandsRouter from "./brands";
import dashboardRouter from "./dashboard";
import comparisonRouter from "./comparison";
import compareFileRouter from "./compare-file";
import uploadsRouter from "./uploads";
import insightsRouter from "./insights";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(distributorsRouter);
router.use(brandsRouter);
router.use(dashboardRouter);
router.use(comparisonRouter);
router.use(compareFileRouter);
router.use(uploadsRouter);
router.use(insightsRouter);

export default router;
