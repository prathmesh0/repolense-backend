import { Repo } from "../models/repo.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { findActiveJob, getQueueInfo } from "../services/jobQueue.service.js";
import {
  fetchGithubRepoMeta,
  ingestRepo,
  parseRepoUrl,
} from "../services/repoIngest.service.js";
import { refundAnalysis, reserveAnalysis } from "../services/demo.service.js";
import { demoConfig } from "../utils/demoConfig.js";
import { computeProgress } from "../services/repoStatus.service.js";
import { Analysis } from "../models/analysis.model.js";
import { logger } from "../utils/logger.js";

const demoError = (status, message, code) =>
  new ApiError(status, message, [{ code }]);

// Main controller with Parrallel processing

const analyseRepo = asyncHandler(async (req, res) => {
  const { url } = req.body;
  const userId = req.user?._id;

  if (!userId) {
    throw new ApiError(401, "Unauthorized: User not found in request.");
  }

  // Validate Github URL
  if (typeof url !== "string" || url.length > 300) {
    throw new ApiError(400, "Invalid Github repo URL");
  }
  const parsed = parseRepoUrl(url);
  if (!parsed) {
    throw new ApiError(400, "Invalid Github repo URL");
  }

  const { owner, name, url: normalizedUrl } = parsed;
  const isDemo = Boolean(req.user.isDemo);
  const inProgressResponse = (repo) =>
    res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { basicInfo: repo },
          "Analysis for this repository is already in progress."
        )
      );

  if (isDemo) {
    // A repo the guest already analysed is returned as is: no GitHub calls,
    // no re-run, no quota.
    const existing = await Repo.findOne({ url: normalizedUrl, user: userId });
    if (existing) {
      if (await findActiveJob(existing._id)) return inProgressResponse(existing);
      return res
        .status(200)
        .json(
          new ApiResponse(
            200,
            { basicInfo: existing },
            "You already analysed this repository."
          )
        );
    }
  }

  const meta = await fetchGithubRepoMeta(owner, name);

  if (isDemo) {
    const { maxRepoKb, maxAnalyses } = demoConfig();
    if (meta.repoData.private) {
      throw demoError(
        400,
        "The demo can only analyse public repositories.",
        "DEMO_REPO_NOT_ALLOWED"
      );
    }
    if ((meta.repoData.size ?? 0) > maxRepoKb) {
      throw demoError(
        400,
        "This repository is too large for the demo. Try a smaller one, or sign up.",
        "DEMO_REPO_TOO_LARGE"
      );
    }

    // Take a quota slot only now: bad URLs and missing, private or oversize
    // repos above never cost one.
    if (!(await reserveAnalysis(userId))) {
      logger.info(
        { event: "demo_limit_hit", kind: "analyse" },
        "Demo limit hit"
      );
      throw demoError(
        403,
        `Demo limit reached (${maxAnalyses} analyses). Sign up to analyse more.`,
        "DEMO_LIMIT_REACHED"
      );
    }
  }

  let result;
  try {
    result = await ingestRepo({
      userId,
      owner,
      name,
      url: normalizedUrl,
      meta,
      extra: isDemo ? { ownerIsDemo: true } : {},
      priority: isDemo ? 1 : 0,
    });
  } catch (error) {
    // The slot was not used: nothing was started
    if (isDemo) await refundAnalysis(userId);
    // Two quick clicks: the other request created the repo first
    if (isDemo && error.code === 11000) {
      const repo = await Repo.findOne({ url: normalizedUrl, user: userId });
      if (repo) return inProgressResponse(repo);
    }
    throw error;
  }

  if (result.inProgress) {
    if (isDemo) await refundAnalysis(userId);
    return inProgressResponse(result.repo);
  }

  if (isDemo) logger.info({ event: "demo_analyse" }, "Demo analyse");

  // Return response immediately
  return res
    .status(201)
    .json(
      new ApiResponse(
        201,
        { basicInfo: result.repo },
        "Repository added successfully; analysis running in background."
      )
    );
});

// Pre-analysed sample repos that every logged-in user can open
const getSampleRepos = asyncHandler(async (_req, res) => {
  const samples = await Repo.find({
    isSample: true,
    fileStructureStatus: "ready",
    embeddingStatus: "ready",
  })
    .sort({ name: 1 })
    .lean();
  return res.json(
    new ApiResponse(
      200,
      samples.map((r) => ({
        repoId: r._id,
        name: r.name,
        owner: r.owner,
        description: r.description || "",
        language: r.languages?.[0] ?? null,
        stars: r.stars ?? 0,
      })),
      "Sample repositories fetched successfully"
    )
  );
});

// Get repo Info
const getRepoInfo = asyncHandler(async (req, res) => {
  const { info } = req.query; // ✅ flag from frontend

  const valid = ["basicAnalysis", "fileStructure", "aiAnalysis", undefined];
  if (!valid.includes(info))
    throw new ApiError(400, "Invalid info query param");

  // Ownership already verified by requireOwnedRepo
  const repo = req.repo;

  let responseData = {};
  let message = "Repository information fetched successfully.";

  switch (info) {
    case "basicAnalysis":
      responseData = {
        basicInfo: {
          _id: repo._id,
          name: repo.name,
          owner: repo.owner,
          url: repo.url,
          stars: repo.stars,
          forks: repo.forks,
          watchers: repo.watchers,
          commitCount: repo.commitCount,
          branches: repo.branches,
          contributors: repo.contributors,
          lastSynced: repo.lastSynced,
          description: repo.description,
          createdAt: repo.createdAt,
          updatedAt: repo.updatedAt,
          languages: repo.languages,
        },
        statuses: {
          fileStructureStatus: repo.fileStructureStatus || "pending",
          aiStatus: repo.aiStatus || "pending",
          embeddingStatus: repo.embeddingStatus || "pending",
        },
        progress: computeProgress(repo),
        statusErrors: repo.statusErrors || {},
        job: await getQueueInfo(repo._id),
      };
      message = "Basic repository info fetched successfully.";
      break;

    case "fileStructure":
      responseData = {
        fileStructure: repo.fileStructure || null,
        status: repo.fileStructureStatus || "pending",
      };
      message = "File structure fetched successfully.";
      break;

    case "aiAnalysis": {
      let analysis = null;
      if (repo.aiAnalysis) {
        analysis = await Analysis.findById(repo.aiAnalysis);
      }
      responseData = {
        aiAnalysis: analysis || null,
        status: repo.aiStatus || "pending",
      };
      message = "AI analysis fetched successfully.";
      break;
    }

    default: {
      // ✅ Send everything
      let fullAnalysis = null;
      if (repo.aiAnalysis) {
        fullAnalysis = await Analysis.findById(repo.aiAnalysis);
      }
      responseData = {
        basicInfo: {
          _id: repo._id,
          name: repo.name,
          owner: repo.owner,
          url: repo.url,
          stars: repo.stars,
          forks: repo.forks,
          watchers: repo.watchers,
          commitCount: repo.commitCount,
          branches: repo.branches,
          contributors: repo.contributors,
          lastSynced: repo.lastSynced,
          description: repo.description,
          createdAt: repo.createdAt,
          updatedAt: repo.updatedAt,
          languages: repo.languages,
        },
        fileStructure: repo.fileStructure || null,
        aiAnalysis: fullAnalysis || null,
        statuses: {
          fileStructureStatus: repo.fileStructureStatus || "pending",
          aiStatus: repo.aiStatus || "pending",
          embeddingStatus: repo.embeddingStatus || "pending",
        },
        progress: computeProgress(repo),
        statusErrors: repo.statusErrors || {},
        job: await getQueueInfo(repo._id),
      };
      message = "Full repository details fetched successfully.";
      break;
    }
  }


  return res.status(200).json(new ApiResponse(200, responseData, message));
});

export { analyseRepo, getRepoInfo, getSampleRepos };
