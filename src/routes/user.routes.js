import { Router } from "express";
import {
  loginUser,
  logoutUser,
  registerUser,
  refreshAccessToken,
  getUserRepoHistoryAndChats,
  getCurrentUser,
  demoLogin,
} from "../controllers/user.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { verifyTurnstile } from "../middlewares/turnstile.middleware.js";
import {
  authLimiter,
  demoLoginDailyLimiter,
  demoLoginHourlyLimiter,
} from "../middlewares/rateLimit.middleware.js";

const router = Router();

router.route("/register").post(authLimiter, registerUser);
router.route("/login").post(authLimiter, loginUser);
router
  .route("/demo-login")
  .post(
    demoLoginHourlyLimiter,
    demoLoginDailyLimiter,
    verifyTurnstile,
    demoLogin
  );

// Secure routes
router.route("/logout").post(verifyJWT, logoutUser);
router.route("/me").get(verifyJWT, getCurrentUser);
router.route("/repo-history").get(verifyJWT, getUserRepoHistoryAndChats);
router.route("/refresh-token").post(authLimiter, refreshAccessToken);

export default router;
