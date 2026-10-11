import { extractFileStructureInternal } from "./fileStructure.service.js";
import { analyzeRepoWithAIInternal } from "./getBasicAIAnalysis.js";
import { generateEmbeddingsForRepo } from "./embed.service.js";
import { failProcessingStages, markStageFailed } from "./repoStatus.service.js";
import { logger } from "../utils/logger.js";

// File extraction feeds both later stages, so they only run if it succeeded.
// Each stage records its own ready/failed status and never throws.
export async function runAnalysisPipeline(repoId, owner, name) {
  try {
    const extracted = await extractFileStructureInternal(repoId, owner, name);

    if (!extracted) {
      const message = "Skipped because the repository files could not be read.";
      await Promise.all([
        markStageFailed(repoId, "ai", message),
        markStageFailed(repoId, "embedding", message),
      ]);
      return;
    }
    logger.info("✅ File structure extraction complete");

    await Promise.all([
      analyzeRepoWithAIInternal(repoId),
      generateEmbeddingsForRepo(repoId),
    ]);
    logger.info("AI analysis & Embeddings finished");
  } catch (error) {
    // Last resort: never leave a stage "processing" after the pipeline dies
    logger.error("Analysis pipeline error:", error);
    await failProcessingStages(
      { _id: repoId },
      "Something went wrong during analysis. Please try again."
    ).catch(() => {});
  }
}
