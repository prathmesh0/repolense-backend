import mongoose from "mongoose";
import { Repo } from "../models/repo.model.js";
import { ApiError } from "../utils/apiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Requires verifyJWT to have run. Loads the repo only if it belongs to the
// current user; a foreign repo gets the same 404 as a missing one so IDs
// can't be probed.
export const requireOwnedRepo = asyncHandler(async (req, _res, next) => {
  const { repoId } = req.params;

  if (!mongoose.isValidObjectId(repoId)) {
    throw new ApiError(400, "Invalid repository id");
  }

  const repo = await Repo.findOne({ _id: repoId, user: req.user._id });
  if (!repo) throw new ApiError(404, "Repository not found");

  req.repo = repo;
  next();
});
