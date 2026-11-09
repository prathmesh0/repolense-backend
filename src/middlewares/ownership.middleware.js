import mongoose from "mongoose";
import { Repo } from "../models/repo.model.js";
import { ApiError } from "../utils/apiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const loadRepo = (allowSamples) =>
  asyncHandler(async (req, _res, next) => {
    const { repoId } = req.params;

    if (!mongoose.isValidObjectId(repoId)) {
      throw new ApiError(400, "Invalid repository id");
    }

    const filter = allowSamples
      ? { _id: repoId, $or: [{ user: req.user._id }, { isSample: true }] }
      : { _id: repoId, user: req.user._id };
    const repo = await Repo.findOne(filter);
    if (!repo) throw new ApiError(404, "Repository not found");

    req.repo = repo;
    next();
  });

// Requires verifyJWT to have run. Loads the repo only if it belongs to the
// current user; a foreign repo gets the same 404 as a missing one so IDs
// can't be probed.
export const requireOwnedRepo = loadRepo(false);

// Same, but also lets any logged-in user read and chat with a demo sample
// repo (req.repo.isSample). Samples are shared: handlers must never write to
// them, and chats on them are stored per user (see chatScope).
export const requireAccessibleRepo = loadRepo(true);
