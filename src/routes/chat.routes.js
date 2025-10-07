import { Router } from "express";
import { chatWithRepoController } from "../controllers/chat.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";

const router = Router();

router.route("/chat/:repoId").post(verifyJWT, chatWithRepoController);

export default router;
