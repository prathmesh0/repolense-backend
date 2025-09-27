import { Repo } from "../models/repo.model.js";
import { Octokit } from "@octokit/rest";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { User } from "../models/user.model.js";

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

    // Github API calls

    // Fetch repo metaData
    const { data: repoData } = await octokit.repos.get({
      owner,
      repo: name,
    });

    // Fetch Branches
    const { data: branchData } = await octokit.repos.listBranches({
      owner,
      repo: name,
      per_page: 100,
    });
    const branches = branchData.map((b) => b.name);

    // Fetch Contributors
    const { data: contributorData } = await octokit.repos.listContributors({
      owner,
      repo: name,
      per_page: 100,
    });

    const contributors = contributorData.map((c) => c.login);

    // Fetch Languages
    const { data: langData } = await octokit.repos.listLanguages({
      owner,
      repo: name,
    });
    const languages = Object.keys(langData); // only language names

    // Fetch commits count
    let totalCommits = 0;
    try {
      const commitsResponse = await octokit.repos.listCommits({
        owner,
        repo: name,
        per_page: 1,
      });
      const linkHeader = commitsResponse.headers.link;
      if (linkHeader) {
        const lastPageMatch = linkHeader.match(/&page=(\d+)>; rel="last"/);
        if (lastPageMatch) {
          totalCommits = parseInt(lastPageMatch[1], 10);
        }
      } else {
        totalCommits = commitsResponse.data.length;
      }
    } catch (err) {
      totalCommits = 0; // fallback if repo is empty or API fails
    }

    let repo = await Repo.findOne({
      url: normalizedUrl,
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
      });
    }

    // Link Repo to User
    const user = await User.findById(userId);
    if (!user) {
      throw new ApiError(404, "User not found");
    }

    const alreadyAdded = user.repoHistory.some(
      (repoId) => repoId.toString() === repo._id.toString()
    );

    if (alreadyAdded) {
      return res
        .status(200)
        .json(
          new ApiResponse(
            200,
            { basicInfo: repo },
            "Repo metadata refreshed. Already in your repo history."
          )
        );
    }

    user.repoHistory.push(repo._id);
    await user.save();

    //   return res
    return res.status(201).json(
      new ApiResponse(
        200,
        {
          basicInfo: repo,
        },
        "Basic analysis of repo done successfully"
      )
    );
  } catch (error) {
    res.status(500).json({
      message: "Error adding repo",
      error: error.message,
    });
  }
});

export { analyseRepo };
