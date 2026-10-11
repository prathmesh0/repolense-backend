import { Router } from "express";
import {
  chatWithRepoController,
  getChatHistoryForRepo,
} from "../controllers/chat.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { requireOwnedRepo } from "../middlewares/ownership.middleware.js";
import { chatLimiter } from "../middlewares/rateLimit.middleware.js";

const router = Router();

router
  .route("/chat/:repoId")
  .post(verifyJWT, requireOwnedRepo, chatLimiter, chatWithRepoController);
router
  .route("/chat-history/:repoId")
  .get(verifyJWT, requireOwnedRepo, getChatHistoryForRepo);

export default router;
