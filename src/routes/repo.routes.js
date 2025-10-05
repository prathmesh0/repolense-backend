import { Router } from "express";
import { analyseRepo, getRepoInfo } from "../controllers/repo.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";

const router = Router();

router.route("/analyse").post(verifyJWT, analyseRepo);

router.route("/getRepoInfo/:repoId").get(getRepoInfo);

export default router;
