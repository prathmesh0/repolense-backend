import { Router } from "express";
import { analyseRepo, getRepoInfo } from "../controllers/repo.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { requireOwnedRepo } from "../middlewares/ownership.middleware.js";
import { analyseLimiter } from "../middlewares/rateLimit.middleware.js";

const router = Router();

router.route("/analyse").post(verifyJWT, analyseLimiter, analyseRepo);

router
  .route("/getRepoInfo/:repoId")
  .get(verifyJWT, requireOwnedRepo, getRepoInfo);

export default router;
