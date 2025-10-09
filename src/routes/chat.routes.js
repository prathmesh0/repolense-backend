import { Router } from "express";
import {
  chatWithRepoController,
  getChatHistoryForRepo,
} from "../controllers/chat.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";

const router = Router();

router.route("/chat/:repoId").post(verifyJWT, chatWithRepoController);
router.route("/chat-history/:repoId").post(verifyJWT, getChatHistoryForRepo);

export default router;
