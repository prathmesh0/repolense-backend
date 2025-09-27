import { Router } from "express";
import { analyseRepo } from "../controllers/repo.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";

const router = Router();

router.route("/analyse").post(verifyJWT, analyseRepo);

export default router;
