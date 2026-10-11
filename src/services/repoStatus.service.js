import { Repo } from "../models/repo.model.js";
import { STALE_PROCESSING_MS } from "../constants.js";
import { logger } from "../utils/logger.js";

// stage name -> Repo status field
export const STAGES = {
  fileStructure: "fileStructureStatus",
  ai: "aiStatus",
  embedding: "embeddingStatus",
};

const INTERRUPTED_MESSAGE =
  "Analysis was interrupted. Please analyse the repository again.";

// Messages shown to users. Raw errors can contain IPs or internals, so map
// the known cases and fall back to a generic text.
export function userFacingError(error, fallback) {
  const status = error?.status;
  const text = String(error?.message ?? "");
  if (status === 429 || (status === 403 && /rate limit/i.test(text))) {
    return "GitHub rate limit reached. Please try again later.";
  }
  if (status === 404) return "Repository not found or inaccessible.";
  if (status === 401) return "GitHub access was denied.";
  return fallback;
}

export async function markStageFailed(repoId, stage, message) {
  await Repo.findByIdAndUpdate(repoId, {
    $set: {
      [STAGES[stage]]: "failed",
      [`statusErrors.${stage}`]: message,
    },
  });
}

// Progress is informational, so a failed write must never break a stage.
// Each write also refreshes updatedAt, which the stuck-repo sweep relies on.
export async function reportProgress(repoId, stage, done, total) {
  try {
    await Repo.updateOne(
      { _id: repoId },
      { $set: { [`progress.${stage}`]: { done, total } } }
    );
  } catch (error) {
    logger.warn(`Could not save ${stage} progress:`, error.message);
  }
}

// Fails every stage that is still "processing" for repos matching `filter`.
export async function failProcessingStages(filter, message) {
  let count = 0;
  for (const [stage, field] of Object.entries(STAGES)) {
    const result = await Repo.updateMany(
      { ...filter, [field]: "processing" },
      { $set: { [field]: "failed", [`statusErrors.${stage}`]: message } }
    );
    count += result.modifiedCount;
  }
  return count;
}

export async function sweepStuckRepos(maxAgeMs) {
  const cutoff = new Date(Date.now() - maxAgeMs);

  // Select repos first, then fail them by id. Filtering each stage update by
  // updatedAt would miss later stages, because the first update refreshes it.
  const stuck = await Repo.find(
    {
      updatedAt: { $lt: cutoff },
      $or: Object.values(STAGES).map((field) => ({ [field]: "processing" })),
    },
    "_id"
  ).lean();
  if (!stuck.length) return 0;

  const count = await failProcessingStages(
    { _id: { $in: stuck.map((r) => r._id) } },
    INTERRUPTED_MESSAGE
  );
  if (count) logger.warn(`🧹 Marked ${count} stuck stage(s) as failed`);
  return count;
}

// Call once after the database is connected.
export function startStatusSweeper() {
  // On boot, in-process work from the previous run is gone. The short window
  // avoids touching a run an overlapping instance may still be doing.
  sweepStuckRepos(2 * 60 * 1000).catch((e) =>
    logger.error("Startup sweep failed:", e.message)
  );

  // Catches runs that die without a restart
  setInterval(
    () =>
      sweepStuckRepos(STALE_PROCESSING_MS).catch((e) =>
        logger.error("Status sweep failed:", e.message)
      ),
    5 * 60 * 1000
  ).unref();
}

// Weighted overall progress. A finished stage (ready or failed) counts as
// complete; the AI stage is one LLM call, so it is 0 until it finishes.
const WEIGHTS = { fileStructure: 0.3, ai: 0.2, embedding: 0.5 };

export function computeProgress(repo) {
  const fraction = (stage) => {
    const state = repo[STAGES[stage]];
    if (state === "ready" || state === "failed") return 1;
    if (state !== "processing") return 0;
    const p = repo.progress?.[stage];
    return p?.total ? Math.min(p.done / p.total, 1) : 0;
  };

  const percent = Math.round(
    Object.entries(WEIGHTS).reduce(
      (sum, [stage, weight]) => sum + fraction(stage) * weight,
      0
    ) * 100
  );

  return {
    percent,
    fileStructure: {
      done: repo.progress?.fileStructure?.done ?? 0,
      total: repo.progress?.fileStructure?.total ?? 0,
    },
    embedding: {
      done: repo.progress?.embedding?.done ?? 0,
      total: repo.progress?.embedding?.total ?? 0,
    },
  };
}
