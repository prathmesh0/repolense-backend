import { Repo } from "../models/repo.model.js";
import { File } from "../models/file.model.js";
import { ApiError } from "../utils/apiError.js";
import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN || null });

// Recursive fetch and save functions
const fetchContentsRecursive = async (owner, repoName, path = "") => {
  const { data } = await octokit.repos.getContent({
    owner,
    repo: repoName,
    path,
  });
  if (Array.isArray(data)) {
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

const saveFilesRecursive = async (node, repoId, owner, repoName) => {
  if (node.type === "file") {
    let content = "";
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo: repoName,
        path: node.path,
      });
      if (data && data.content && data.encoding === "base64") {
        content = Buffer.from(data.content, "base64").toString("utf8");
      }
    } catch (error) {
      console.error(`Error fetching file ${node.path}:`, error.message);
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

async function extractFileStructureInternal(repoId, owner, name) {
  try {
    // set Status to processing
    await Repo.findByIdAndUpdate(repoId, { fileStructureStatus: "processing" });

    const fileTree = await fetchContentsRecursive(owner, name);
    await Repo.findByIdAndUpdate(repoId, { fileStructure: fileTree });
    await saveFilesRecursive(fileTree, repoId, owner, name);

    await Repo.findByIdAndUpdate(repoId, { fileStructureStatus: "ready" });
  } catch (error) {
    console.error("File structure extraction error:", error.message);

    // 🔴 Mark failure
    await Repo.findByIdAndUpdate(repoId, { fileStructureStatus: "failed" });
    
  }
}

export { extractFileStructureInternal };
