import { Router } from "express";
import { extractFileStructure } from "../controllers/file.controller.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";

const router = Router();

router
  .route("/analyseFileStructure/:repoId")
  .post(verifyJWT, extractFileStructure);

export default router;
