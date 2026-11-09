import { Repo } from "../models/repo.model.js";
import { User } from "../models/user.model.js";
import { octokit } from "./github.client.js";
import { enqueueAnalysis, findActiveJob } from "./jobQueue.service.js";
import { ApiError } from "../utils/apiError.js";
import { logger } from "../utils/logger.js";

export const parseRepoUrl = (url) => {
  try {
    // Remove trailing slashes and .git
    const normalizedUrl = url.replace(/\/+$/, "").replace(/\.git$/, "");
    const match = normalizedUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) return null;
    return { owner: match[1], name: match[2], url: normalizedUrl };
  } catch (error) {
    logger.error("Error details:", error);
    throw new ApiError(401, "Error parsing GitHub URL");
  }
};

// Everything the app stores about a repo that comes from GitHub
export async function fetchGithubRepoMeta(owner, name) {
  let repoData, branchData, contributorData, langData;
  try {
    const responses = await Promise.all([
      octokit.repos.get({ owner, repo: name }),
      octokit.repos.listBranches({ owner, repo: name, per_page: 100 }),
      octokit.repos.listContributors({ owner, repo: name, per_page: 100 }),
      octokit.repos.listLanguages({ owner, repo: name }),
    ]);
    repoData = responses[0].data;
    branchData = responses[1].data;
    contributorData = responses[2].data;
    langData = responses[3].data;
  } catch (err) {
    if (err.status === 404) {
      throw new ApiError(404, "GitHub repository not found or inaccessible");
    } else if (err.status === 401) {
      throw new ApiError(401, "Unauthorized - Invalid or expired GitHub token");
    } else {
      throw new ApiError(
        500,
        "Something went wrong while accessing GitHub API"
      );
    }
  }

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
    logger.warn("Could not fetch commits:", err.message);
  }

  return { repoData, branches, contributors, languages, totalCommits };
}

// Creates or refreshes the user's Repo, links it to their history and queues
// the analysis. Returns { repo, inProgress }: with inProgress the repo already
// had a live job, nothing was changed and nothing was queued.
//   extra     fields set only when the repo is created (isSample, ownerIsDemo)
//   priority  queue priority, lower runs first (demo guests use 1)
export async function ingestRepo({
  userId,
  owner,
  name,
  url,
  meta,
  extra = {},
  priority = 0,
}) {
  const { repoData, branches, contributors, languages, totalCommits } = meta;

  // Find/create repo per-user to avoid cross-user sharing
  let repo = await Repo.findOne({ url, user: userId });

  if (repo) {
    // An analysis is already queued or running: don't start another one that
    // would delete and rebuild the same files/embeddings underneath it.
    if (await findActiveJob(repo._id)) {
      return { repo, inProgress: true };
    }

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
      url,
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
      ...extra,
    });
  }

  // Link Repo to User (atomic)
  await User.findByIdAndUpdate(
    userId,
    { $addToSet: { repoHistory: repo._id } }, // adds only if not present
    { new: true }
  );

  // mark processing (persist) and clear the previous run's progress/errors
  repo.fileStructureStatus = "processing";
  repo.aiStatus = "processing";
  repo.embeddingStatus = "processing";
  repo.set("progress", {
    fileStructure: { done: 0, total: 0 },
    embedding: { done: 0, total: 0 },
  });
  repo.set("statusErrors", {});
  await repo.save();

  // Queued for the background worker; the client polls getRepoInfo for
  // status and progress. The queue survives restarts and retries crashed runs.
  await enqueueAnalysis(repo._id, owner, name, { priority });

  return { repo, inProgress: false };
}
