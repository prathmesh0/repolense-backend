import { Router } from "express";
import { analyseRepo, getRepoInfo } from "../controllers/repo.controller.js";
import { streamRepoStatus } from "../controllers/status.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { requireOwnedRepo } from "../middlewares/ownership.middleware.js";
import { analyseLimiter } from "../middlewares/rateLimit.middleware.js";

const router = Router();

router.route("/analyse").post(verifyJWT, analyseLimiter, analyseRepo);

router
  .route("/getRepoInfo/:repoId")
  .get(verifyJWT, requireOwnedRepo, getRepoInfo);
router
  .route("/status-stream/:repoId")
  .get(verifyJWT, requireOwnedRepo, streamRepoStatus);

export default router;
