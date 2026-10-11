import mongoose from "mongoose";
import { Embedding } from "../models/embedding.model.js";
import { cosineSimilarity } from "../utils/cosineSimilarity.js";
import { logger } from "../utils/logger.js";

// Name of the Atlas vector index on the `embeddings` collection.
// Create it with: npm run create:vector-index
export const VECTOR_INDEX_NAME =
  process.env.VECTOR_INDEX_NAME || "embedding_vector_index";

// VECTOR_SEARCH: "auto" (default) uses Atlas when it works and falls back
// otherwise; "atlas" behaves the same but logs louder; "memory" never tries Atlas.
const MODE = (process.env.VECTOR_SEARCH || "auto").toLowerCase();
const RETRY_ATLAS_AFTER_MS = 5 * 60 * 1000;

let atlasDisabledUntil = 0;

const FIELDS = "path chunkIndex contentPreview";

// Atlas $vectorSearch. Returns [] when it finds nothing, which the caller
// treats as "maybe the index has not caught up yet".
async function searchAtlas(repoId, queryVector, k) {
  const rows = await Embedding.aggregate([
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: "vector",
        queryVector,
        numCandidates: Math.max(100, k * 20),
        limit: k,
        filter: { repo: new mongoose.Types.ObjectId(String(repoId)) },
      },
    },
    {
      $project: {
        _id: 0,
        path: 1,
        chunkIndex: 1,
        contentPreview: 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ]);
  return rows;
}

// Streams the repo's embeddings and keeps only the best k, instead of loading
// and sorting all of them in memory.
async function searchInMemory(repoId, queryVector, k) {
  const best = [];
  const cursor = Embedding.find({ repo: repoId }, `${FIELDS} vector`)
    .lean()
    .cursor();

  for await (const e of cursor) {
    const score = cosineSimilarity(queryVector, e.vector);
    if (best.length < k || score > best[best.length - 1].score) {
      best.push({
        path: e.path,
        chunkIndex: e.chunkIndex,
        contentPreview: e.contentPreview,
        score,
      });
      best.sort((a, b) => b.score - a.score);
      if (best.length > k) best.pop();
    }
  }
  return best;
}

// Returns the k most similar chunks of one repo: [{path, chunkIndex,
// contentPreview, score}], best first.
export async function findSimilarChunks(repoId, queryVector, k = 5) {
  if (MODE !== "memory" && Date.now() >= atlasDisabledUntil) {
    try {
      const rows = await searchAtlas(repoId, queryVector, k);
      if (rows.length) return rows;
      // Empty can mean the index has not seen fresh vectors yet (Atlas indexes
      // asynchronously), so double-check against the data itself.
    } catch (error) {
      // Not on Atlas, index missing, or a transient failure: stop trying for a
      // while so chat does not pay for a failing call every time.
      atlasDisabledUntil = Date.now() + RETRY_ATLAS_AFTER_MS;
      const log = MODE === "atlas" ? logger.error : logger.warn;
      log(
        "Vector search unavailable, using in-memory search for %d min: %s",
        RETRY_ATLAS_AFTER_MS / 60000,
        error.message
      );
    }
  }
  return searchInMemory(repoId, queryVector, k);
}

// Test hook
export function resetVectorSearchState() {
  atlasDisabledUntil = 0;
}
