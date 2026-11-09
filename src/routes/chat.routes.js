import { Router } from "express";
import {
  chatWithRepoController,
  getChatHistoryForRepo,
} from "../controllers/chat.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { requireAccessibleRepo } from "../middlewares/ownership.middleware.js";
import { chatLimiter } from "../middlewares/rateLimit.middleware.js";
import { demoChatQuota } from "../middlewares/demoQuota.middleware.js";

const router = Router();

router
  .route("/chat/:repoId")
  .post(
    verifyJWT,
    requireAccessibleRepo,
    chatLimiter,
    demoChatQuota,
    chatWithRepoController
  );
router
  .route("/chat-history/:repoId")
  .get(verifyJWT, requireAccessibleRepo, getChatHistoryForRepo);

export default router;
