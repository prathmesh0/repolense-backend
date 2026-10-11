import { Repo } from "../models/repo.model.js";
import { File } from "../models/file.model.js";
import { Octokit } from "@octokit/rest";
import { redactSecrets } from "../utils/secrets.js";
import {
  markStageFailed,
  reportProgress,
  userFacingError,
} from "./repoStatus.service.js";
import {
  MAX_FILE_BYTES,
  MAX_FILES_TO_FETCH,
  shouldIndexFile,
} from "../utils/fileFilters.js";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN || null });

const BLOB_CONCURRENCY = 8;
const INSERT_BATCH_SIZE = 200;

const extensionOf = (name) =>
  name.includes(".") ? name.substring(name.lastIndexOf(".")) : "";

// Runs `worker` over `items` with at most `limit` in flight
async function mapWithConcurrency(items, limit, worker, onItemDone) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
        onItemDone?.();
      }
    }
  );
  await Promise.all(runners);
  return results;
}

// Builds the nested tree the frontend renders from the flat git tree.
// Directory nodes keep the full path as their name, as before.
const buildTree = (entries) => {
  const root = { type: "dir", name: "root", children: [] };
  const dirs = new Map([["", root]]);

  const ensureDir = (path) => {
    if (dirs.has(path)) return dirs.get(path);
    const parentPath = path.includes("/")
      ? path.substring(0, path.lastIndexOf("/"))
      : "";
    const node = { type: "dir", name: path, children: [] };
    dirs.set(path, node);
    ensureDir(parentPath).children.push(node);
    return node;
  };

  for (const entry of entries) {
    if (entry.type === "tree") {
      ensureDir(entry.path);
    } else if (entry.type === "blob") {
      const slash = entry.path.lastIndexOf("/");
      const parent = ensureDir(slash === -1 ? "" : entry.path.slice(0, slash));
      const name = entry.path.slice(slash + 1);
      parent.children.push({
        type: "file",
        name,
        path: entry.path,
        size: entry.size ?? 0,
        extension: extensionOf(name),
      });
    }
    // "commit" entries are submodules; nothing to show or fetch
  }
  return root;
};

async function extractFileStructureInternal(repoId, owner, name) {
  try {
    // set Status to processing
    await Repo.findByIdAndUpdate(repoId, { fileStructureStatus: "processing" });

    // One call for the whole tree instead of one call per directory
    const { data: repoMeta } = await octokit.repos.get({ owner, repo: name });
    const { data: tree } = await octokit.git.getTree({
      owner,
      repo: name,
      tree_sha: repoMeta.default_branch,
      recursive: "1",
    });
    if (tree.truncated) {
      console.warn(
        `⚠️ Git tree truncated for ${owner}/${name}; very large repo`
      );
    }

    await Repo.findByIdAndUpdate(repoId, {
      fileStructure: buildTree(tree.tree),
    });

    // Decide what to download BEFORE downloading: text/code files only, no
    // ignored folders, credential files, or oversized files.
    const candidates = tree.tree
      .filter(
        (e) =>
          e.type === "blob" &&
          (e.size ?? 0) <= MAX_FILE_BYTES &&
          shouldIndexFile(e.path)
      )
      // Shallow files (README, configs, entry points) matter most if we cap
      .sort(
        (a, b) =>
          a.path.split("/").length - b.path.split("/").length || a.size - b.size
      )
      .slice(0, MAX_FILES_TO_FETCH);

    let done = 0;
    await reportProgress(repoId, "fileStructure", 0, candidates.length);
    const fetched = await mapWithConcurrency(
      candidates,
      BLOB_CONCURRENCY,
      async (entry) => {
        try {
          const { data } = await octokit.git.getBlob({
            owner,
            repo: name,
            file_sha: entry.sha,
          });
          const content = redactSecrets(
            Buffer.from(data.content, "base64").toString("utf8")
          );
          const fileName = entry.path.split("/").pop();
          return {
            repo: repoId,
            path: entry.path,
            type: "file",
            size: entry.size,
            extension: extensionOf(fileName),
            content,
          };
        } catch (error) {
          // One unreadable file shouldn't fail the whole repo
          console.error(`Error fetching file ${entry.path}:`, error.message);
          return null;
        }
      },
      () => {
        done++;
        // Every 10 files; each write also keeps updatedAt fresh
        if (done % 10 === 0 && done < candidates.length) {
          reportProgress(repoId, "fileStructure", done, candidates.length);
        }
      }
    );
    await reportProgress(
      repoId,
      "fileStructure",
      candidates.length,
      candidates.length
    );

    // Re-analysis must replace old files, not pile up duplicates
    await File.deleteMany({ repo: repoId });
    const docs = fetched.filter(Boolean);
    for (let i = 0; i < docs.length; i += INSERT_BATCH_SIZE) {
      await File.insertMany(docs.slice(i, i + INSERT_BATCH_SIZE), {
        ordered: false,
      });
    }
    console.log(
      `📁 Stored ${docs.length}/${candidates.length} files for ${owner}/${name}`
    );

    await Repo.findByIdAndUpdate(repoId, { fileStructureStatus: "ready" });
    return true;
  } catch (error) {
    console.error("File structure extraction error:", error.message);

    // 🔴 Mark failure
    await markStageFailed(
      repoId,
      "fileStructure",
      userFacingError(error, "Could not read the repository files.")
    );
    return false;
  }
}

export { extractFileStructureInternal };
