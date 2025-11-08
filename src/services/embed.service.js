import { pipeline } from "@xenova/transformers";
import { Embedding } from "../models/embedding.model.js";
import { File } from "../models/file.model.js";
import { Repo } from "../models/repo.model.js";
import micromatch from "micromatch";
import {
  IMPORTANT_ROOT_FILES,
  IGNORED_PATHS,
  textExtensions,
} from "../constants.js";

const CHUNK_SIZE = 1024; // chars per chunk
const CHUNK_OVERLAP = 0.3; // 30% overlap

function shouldEmbedFile(filePath, fileName, repoRoot = "") {
  // Normalize path relative to repoRoot if given
  let relPath =
    repoRoot && filePath.startsWith(repoRoot)
      ? filePath.substring(repoRoot.length).replace(/^\/+/, "")
      : filePath;

  // Always embed important root files located at root (no slashes in relPath)
  if (
    !relPath.includes("/") &&
    IMPORTANT_ROOT_FILES.some(
      (important) => important.toLowerCase() === fileName.toLowerCase()
    )
  ) {
    return true;
  }

  // Ignore files in ignored directories/patterns
  if (micromatch.isMatch(relPath, IGNORED_PATHS)) {
    return false;
  }

  // Finally, check if file extension is a recognized text/code type
  return isTextFile(fileName || filePath);
}

function isTextFile(path) {
  // Check by extension or name
  return textExtensions.some((ext) => path.toLowerCase().endsWith(ext));
}

function chunkText(text) {
  const step = Math.floor(CHUNK_SIZE * (1 - CHUNK_OVERLAP));
  let chunks = [];
  for (let start = 0; start < text.length; start += step) {
    chunks.push(text.slice(start, start + CHUNK_SIZE));
    if (start + CHUNK_SIZE >= text.length) break;
  }
  return chunks;
}

let embeddingModel = null;

async function loadEmbeddingModel() {
  if (!embeddingModel) {
    console.log("⏳ Loading embedding model: all-MiniLM-L6-v2 ...");
    embeddingModel = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2"
    );
    console.log("✅ Embedding model loaded!");
  }
  return embeddingModel;
}

export async function generateEmbeddingsForRepo(repoId) {
  try {
    const model = await loadEmbeddingModel();
    const repo = await Repo.findById(repoId);

    if (!repo) {
      console.error(`❌ Repo not found for ID: ${repoId}`);
      return;
    }

    const files = await File.find({ repo: repoId });
    console.log(`📁 Found ${files.length} files for repo ${repoId}`);

    for (const file of files) {
      if (
        !file.content ||
        !shouldEmbedFile(file.path, file.path.split("/").pop())
      )
        continue;

      const chunks = chunkText(file.content);
      console.log("Chunks Lenght/ Database call", chunks.length);

      for (let idx = 0; idx < chunks.length; idx++) {
        const chunk = chunks[idx];
        const output = await model(chunk, { pooling: "mean", normalize: true });
        const vector = Array.from(output.data);

        await Embedding.create({
          repo: repoId,
          file: file._id,
          path: file.path,
          chunkIndex: idx, // track chunk index per file
          vector,
          contentPreview: chunk, // store entire chunk as context
        });
      }

      console.log(`🧬 Embedded: ${file.path}`);
    }

    // 1️⃣ Embed Repo-level metadata
    const repoSummary = `
    Repository name: ${repo.name}
    Description: ${repo.description || "No description provided"}
    Owner: ${repo.owner}
    Stars: ${repo.stars}, Forks: ${repo.forks}, Watchers: ${repo.watchers}
    Contributors: ${(repo.contributors || []).join(", ")}
    Languages used: ${(repo.languages || []).join(", ")}
    Total commits: ${repo.commitCount}
    `;

    const repoOutput = await model(repoSummary, {
      pooling: "mean",
      normalize: true,
    });
    await Embedding.create({
      repo: repoId,
      file: null,
      path: "REPO_METADATA",
      vector: Array.from(repoOutput.data),
      contentPreview: repoSummary,
    });

    await Repo.findByIdAndUpdate(repoId, { embeddingStatus: "ready" });

    console.log("✅ All embeddings generated successfully!");
  } catch (error) {
    console.error("❌ Embedding generation error:", error.message);

    // 🔴 Mark failure
    await Repo.findByIdAndUpdate(repoId, { embeddingStatus: "failed" });
  }
}
