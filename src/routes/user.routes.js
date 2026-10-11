import { Router } from "express";
import {
  loginUser,
  logoutUser,
  registerUser,
  refreshAccessToken,
  getUserRepoHistoryAndChats,
} from "../controllers/user.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { authLimiter } from "../middlewares/rateLimit.middleware.js";

const router = Router();

router.route("/register").post(authLimiter, registerUser);
router.route("/login").post(authLimiter, loginUser);

// Secure routes
router.route("/logout").post(verifyJWT, logoutUser);
router.route("/repo-history").get(verifyJWT, getUserRepoHistoryAndChats);
router.route("/refresh-token").post(authLimiter, refreshAccessToken);

export default router;
