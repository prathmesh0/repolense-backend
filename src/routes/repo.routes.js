import { Router } from "express";
import {
  analyseRepo,
  getRepoInfo,
  getSampleRepos,
} from "../controllers/repo.controller.js";
import { streamRepoStatus } from "../controllers/status.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { requireAccessibleRepo } from "../middlewares/ownership.middleware.js";
import {
  analyseLimiter,
  demoIpAnalysisLimiter,
} from "../middlewares/rateLimit.middleware.js";

const router = Router();

router
  .route("/analyse")
  .post(verifyJWT, analyseLimiter, demoIpAnalysisLimiter, analyseRepo);

router.route("/samples").get(verifyJWT, getSampleRepos);

router
  .route("/getRepoInfo/:repoId")
  .get(verifyJWT, requireAccessibleRepo, getRepoInfo);
router
  .route("/status-stream/:repoId")
  .get(verifyJWT, requireAccessibleRepo, streamRepoStatus);

export default router;
