import { Repo } from "../models/repo.model.js";
import { Octokit } from "@octokit/rest";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { User } from "../models/user.model.js";
import { extractFileStructureInternal } from "../services/fileStructure.service.js";
import { analyzeRepoWithAIInternal } from "../services/getBasicAIAnlaysis.js";
import { Analysis } from "../models/analysis.model.js";
import { generateEmbeddingsForRepo } from "../services/embed.service.js";

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN || null,
});

const parseRepoUrl = (url) => {
  try {
    // Remove trailing slashes and .git
    const normalizedUrl = url.replace(/\/+$/, "").replace(/\.git$/, "");
    const match = normalizedUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) return null;
    return { owner: match[1], name: match[2], url: normalizedUrl };
  } catch (error) {
    throw new ApiError(401, "Error parsing GitHub URL");
  }
};

// Main controller with Parrallel processing

const analyseRepo = asyncHandler(async (req, res) => {
  try {
    const { url } = req.body;
    const userId = req.user?._id;

    if (!userId) {
      throw new ApiError(401, "Unauthorized: User not found in request.");
    }

    // Validate Github URL
    const parsed = parseRepoUrl(url);
    if (!parsed) {
      throw new ApiError(400, "Invalid Github repo URL");
    }

    const { owner, name, url: normalizedUrl } = parsed;

    // Parallelized GitHub calls
    // ---------------------------
    const [
      { data: repoData },
      { data: branchData },
      { data: contributorData },
      { data: langData },
    ] = await Promise.all([
      octokit.repos.get({ owner, repo: name }),
      octokit.repos.listBranches({ owner, repo: name, per_page: 100 }),
      octokit.repos.listContributors({ owner, repo: name, per_page: 100 }),
      octokit.repos.listLanguages({ owner, repo: name }),
    ]);

    const branches = (branchData || []).map((b) => b.name);
    const contributors = (contributorData || []).map((c) => c.login);
    const languages = Object.keys(langData || {});

    let totalCommits = 0;
    try {
      const commitsResponse = await octokit.repos.listCommits({
        owner,
        repo: name,
        per_page: 1,
      });
      const linkHeader = commitsResponse.headers?.link;
      if (linkHeader) {
        // look for rel="last"
        const lastPageMatch =
          linkHeader.match(/&page=(\d+)[^>]*>\s*;\s*rel="last"/) ||
          linkHeader.match(/page=(\d+)[^>]*>\s*;\s*rel="last"/);
        if (lastPageMatch) {
          totalCommits = parseInt(lastPageMatch[1], 10);
        } else {
          totalCommits = commitsResponse.data.length || 0;
        }
      } else {
        totalCommits = commitsResponse.data.length || 0;
      }
    } catch (err) {
      totalCommits = 0; // safe fallback
      console.warn("Could not fetch commits:", err.message);
    }

    // Find/create repo per-user to avoid cross-user sharing

    let repo = await Repo.findOne({
      url: normalizedUrl,
      user: userId,
    });

    if (repo) {
      // Update existing repo
      repo.name = repoData.name;
      repo.owner = owner;
      repo.stars = repoData.stargazers_count || 0;
      repo.forks = repoData.forks_count || 0;
      repo.watchers = repoData.subscribers_count || 0;
      repo.description = repoData.description || "";
      repo.branches = branches;
      repo.contributors = contributors;
      repo.languages = languages;
      repo.commitCount = totalCommits;
      repo.lastSynced = new Date();

      // Keep statuses as-is if already processing/ready; don't overwrite "ready"
      if (!repo.fileStructureStatus) repo.fileStructureStatus = "pending";
      if (!repo.aiStatus) repo.aiStatus = "pending";
      if (!repo.embeddingStatus) repo.embeddingStatus = "pending";

      await repo.save();
    } else {
      repo = await Repo.create({
        name: repoData.name,
        owner,
        url: normalizedUrl,
        stars: repoData.stargazers_count || 0,
        forks: repoData.forks_count || 0,
        watchers: repoData.subscribers_count || 0,
        description: repoData.description || "",
        branches,
        contributors,
        languages,
        commitCount: totalCommits,
        user: userId,
        lastSynced: new Date(),
        fileStructureStatus: "pending",
        aiStatus: "pending",
        embeddingStatus: "pending",
      });
    }

    // Link Repo to User (atomic)
    await User.findByIdAndUpdate(
      userId,
      { $addToSet: { repoHistory: repo._id } }, // adds only if not present
      { new: true }
    );

    // Ensure repo saved (race prevention)
    await repo.save();

    // START PARALLEL TASK
    // Start background tasks (non-blocking)
    // - Set statuses to processing before enqueue
    // - These functions should update repo.fileStructureStatus / repo.aiStatus on completion

    // mark processing (persist)
    repo.fileStructureStatus = "processing";
    repo.aiStatus = "processing";
    repo.embeddingStatus = "processing";
    await repo.save();

    extractFileStructureInternal(repo._id, owner, name)
      .then(() => {
        console.log("✅ File structure extraction complete");

        // Run AI analysis and embeddings in parallel
        Promise.all([
          analyzeRepoWithAIInternal(repo._id),
          generateEmbeddingsForRepo(repo._id),
        ])
          .then(() => console.log("AI analysis & Embeddings completed"))
          .catch((err) => console.error("Background task error:", err));
      })
      .catch((e) => {
        console.error("File structure extraction error:", e);
        Repo.findByIdAndUpdate(repo._id, {
          fileStructureStatus: "failed",
        }).catch(() => {});
      });

    // Return response immediately
    return res
      .status(201)
      .json(
        new ApiResponse(
          201,
          { basicInfo: repo },
          "Repository added successfully; analysis running in background."
        )
      );
  } catch (error) {
    console.error("analyseRepo error:", error);
    res.status(500).json({
      message: "Error adding repo",
      error: error.message,
    });
  }
});

// Get repo Info
const getRepoInfo = asyncHandler(async (req, res) => {
  const { repoId } = req.params;
  const { info } = req.query; // ✅ flag from frontend

  const valid = ["basicAnalysis", "fileStructure", "aiAnalysis", undefined];
  if (!valid.includes(info))
    throw new ApiError(400, "Invalid info query param");

  const repo = await Repo.findById(repoId);
  if (!repo) throw new ApiError(404, "Repository not found");

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

    case "aiAnalysis":
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

    default:
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
      };
      message = "Full repository details fetched successfully.";
      break;
  }

  return res.status(200).json(new ApiResponse(200, responseData, message));
});

export { analyseRepo, getRepoInfo };
