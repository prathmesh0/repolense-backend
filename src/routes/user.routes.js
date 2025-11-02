import { Router } from "express";
import {
  loginUser,
  logoutUser,
  registerUser,
  refreshAccessToken,
  getUserRepoHistoryAndChats,
} from "../controllers/user.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";

const router = Router();

router.route("/register").post(registerUser);
router.route("/login").post(loginUser);

// Secure routes
router.route("/logout").post(verifyJWT, logoutUser);
router.route("/repo-history").get(verifyJWT, getUserRepoHistoryAndChats);
router.route("/refresh-token").post(refreshAccessToken);

export default router;
