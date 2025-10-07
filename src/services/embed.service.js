import { pipeline } from "@xenova/transformers";
import { Embedding } from "../models/embedding.model.js";
import { File } from "../models/file.model.js";
import { Repo } from "../models/repo.model.js";

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

function isTextFile(path) {
  const textExtensions = [
    // Core languages
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".py",
    ".ipynb",
    ".java",
    ".kt",
    ".kts",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".go",
    ".rs",
    ".swift",
    ".dart",

    // Web & UI
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".vue",
    ".svelte",

    // Backend / Server-side
    ".php",
    ".rb",
    ".rake",
    ".cs",
    ".asp",
    ".jsp",

    // Data & Config
    ".json",
    ".yml",
    ".yaml",
    ".toml",
    ".ini",
    ".env",
    ".xml",
    ".csv",
    ".tsv",

    // Documentation / Text
    ".md",
    ".markdown",
    ".txt",
    ".rst",
    ".tex",
    ".log",

    // Build / DevOps
    ".gradle",
    ".properties",
    ".sh",
    ".bash",
    ".bat",
    "Dockerfile",
    ".dockerignore",
    ".gitignore",
    ".gitattributes",

    // AI / ML Specific
    ".pkl",
    ".pt",
    ".h5",
    ".onnx",
    ".pbtxt",
    ".cfg",
    ".sql",
    ".parquet",
    ".avro", // Some are semi-readable
  ];

  // Check by extension or name
  return textExtensions.some((ext) => path.toLowerCase().endsWith(ext));
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
      contentPreview: repoSummary.slice(0, 500),
    });

    for (const file of files) {
      if (!file.content || file.content.length < 50 || !isTextFile(file.path))
        continue;
      // You can truncate to first 1000 chars to reduce memory usage
      const text = file.content.slice(0, 2000);

      const output = await model(text, { pooling: "mean", normalize: true });
      const vector = Array.from(output.data);
      await Embedding.create({
        repo: repoId,
        file: file._id,
        path: file.path,
        vector,
        contentPreview: text.slice(0, 300),
      });

      console.log(`🧬 Embedded: ${file.path}`);
    }

    await Repo.findByIdAndUpdate(repoId, { embeddingStatus: "ready" });

    console.log("✅ All embeddings generated successfully!");
  } catch (error) {
    console.error("❌ Embedding generation error:", error.message);

    // 🔴 Mark failure
    await Repo.findByIdAndUpdate(repoId, { embeddingStatus: "failed" });
  }
}
