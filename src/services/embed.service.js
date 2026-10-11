import { Embedding } from "../models/embedding.model.js";
import { File } from "../models/file.model.js";
import { Repo } from "../models/repo.model.js";
import { redactSecrets } from "../utils/secrets.js";
import { shouldIndexFile } from "../utils/fileFilters.js";
import { embedText } from "./embeddingModel.js";

const CHUNK_SIZE = 1024; // chars per chunk
const CHUNK_OVERLAP = 0.3; // 30% overlap
const INSERT_BATCH_SIZE = 100; // embeddings per Mongo round trip

function chunkText(text) {
  const step = Math.floor(CHUNK_SIZE * (1 - CHUNK_OVERLAP));
  let chunks = [];
  for (let start = 0; start < text.length; start += step) {
    chunks.push(text.slice(start, start + CHUNK_SIZE));
    if (start + CHUNK_SIZE >= text.length) break;
  }
  return chunks;
}

export async function generateEmbeddingsForRepo(repoId) {
  try {
    const repo = await Repo.findById(repoId);

    if (!repo) {
      console.error(`❌ Repo not found for ID: ${repoId}`);
      return;
    }

    // Re-analysis must replace old vectors, not pile up duplicates
    await Embedding.deleteMany({ repo: repoId });

    // Only load what we need; the cursor avoids holding every file in memory
    const files = File.find(
      { repo: repoId, content: { $nin: [null, ""] } },
      "path content"
    ).cursor();

    let pending = [];
    let embeddedFiles = 0;
    const flush = async () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      await Embedding.insertMany(batch, { ordered: false });
    };

    for await (const file of files) {
      if (!shouldIndexFile(file.path)) continue;

      const chunks = chunkText(redactSecrets(file.content));

      for (let idx = 0; idx < chunks.length; idx++) {
        pending.push({
          repo: repoId,
          file: file._id,
          path: file.path,
          chunkIndex: idx, // track chunk index per file
          vector: await embedText(chunks[idx]),
          contentPreview: chunks[idx], // store entire chunk as context
        });
        if (pending.length >= INSERT_BATCH_SIZE) await flush();
      }
      embeddedFiles++;
    }
    await flush();
    console.log(`🧬 Embedded ${embeddedFiles} files for repo ${repoId}`);

    // Embed Repo-level metadata
    const repoSummary = `
    Repository name: ${repo.name}
    Description: ${repo.description || "No description provided"}
    Owner: ${repo.owner}
    Stars: ${repo.stars}, Forks: ${repo.forks}, Watchers: ${repo.watchers}
    Contributors: ${(repo.contributors || []).join(", ")}
    Languages used: ${(repo.languages || []).join(", ")}
    Total commits: ${repo.commitCount}
    `;

    await Embedding.create({
      repo: repoId,
      file: null,
      path: "REPO_METADATA",
      vector: await embedText(repoSummary),
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
