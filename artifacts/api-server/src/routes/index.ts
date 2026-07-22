import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import adminRouter from "./admin";
import distributorsRouter from "./distributors";
import brandsRouter from "./brands";
import dashboardRouter from "./dashboard";
import comparisonRouter from "./comparison";
import compareFileRouter from "./compare-file";
import comparisonExportRouter from "./comparison-export";
import uploadsRouter from "./uploads";
import insightsRouter from "./insights";
import experimentalRouter from "./experimental";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(adminRouter);
router.use(distributorsRouter);
router.use(brandsRouter);
router.use(dashboardRouter);
router.use(comparisonRouter);
router.use(compareFileRouter);
router.use(comparisonExportRouter);
router.use(uploadsRouter);
router.use(insightsRouter);
router.use(experimentalRouter);

export default router;
