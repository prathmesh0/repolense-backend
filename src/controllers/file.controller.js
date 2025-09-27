import { Repo } from "../models/repo.model.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { Octokit } from "@octokit/rest";
import { File } from "../models/file.model.js";

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN || null,
});

// Recursive helper: build file tree + fetch contents
const fetchContentsRecursive = async (owner, repoName, path = "") => {
  const { data } = await octokit.repos.getContent({
    owner,
    repo: repoName,
    path,
  });

  console.log(data);

  if (Array.isArray(data)) {
    // Directory
    const children = await Promise.all(
      data.map(async (item) => {
        if (item.type === "dir") {
          return await fetchContentsRecursive(owner, repoName, item.path);
        } else {
          return {
            type: "file",
            name: item.name,
            path: item.path,
            size: item.size,
            extension: item.name.includes(".")
              ? item.name.substring(item.name.lastIndexOf("."))
              : "",
          };
        }
      })
    );
    return { type: "dir", name: path || "root", children };
  } else {
    // Single File

    return {
      type: "file",
      name: data.name,
      path: data.path,
      size: data.size,
      extension: data.name.includes(".")
        ? data.name.substring(data.name.lastIndexOf("."))
        : "",
    };
  }
};

// Save files into DB

const saveFilesRecursive = async (node, repoId, owner, repoName) => {
  if (node.type === "file") {
    let content = "";
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo: repoName,
        path: node.path,
      });

      //   if data is there then convert data from base64 to readable manner
      if (data && data.content && data.encoding === "base64") {
        content = Buffer.from(data.content, "base64").toString("utf8");
      }
    } catch (error) {
      console.error(`Error fetching file ${node.path}:`, err.message);
      throw new ApiError(500, "Error in fetching file");
    }

    await File.create({
      repo: repoId,
      path: node.path,
      type: "file",
      size: node.size,
      extension: node.extension,
      content,
    });
  } else if (node.type === "dir" && node.children) {
    for (const child of node.children) {
      await saveFilesRecursive(child, repoId, owner, repoName);
    }
  }
};

export const extractFileStructure = asyncHandler(async (req, res) => {
  const { repoId } = req.params;
  if (!repoId) {
    throw new ApiError(404, "Please send valid Id");
  }
  const repo = await Repo.findById(repoId);

  if (!repo) {
    throw new ApiError(404, "Repo not found");
  }

  const { owner, name } = repo;

  //   Fetch Repo File tree
  const fileTree = await fetchContentsRecursive(owner, name);

  repo.fileStructure = fileTree;
  await repo.save();

  //   Save each file + content in File collection
  await saveFilesRecursive(fileTree, repo._id, owner, name);

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { fileStructure: repo.fileStructure },
        "Repo file structure extracted successfully"
      )
    );
});
