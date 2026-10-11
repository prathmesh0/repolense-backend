import { File } from "../models/file.model.js";
import { Repo } from "../models/repo.model.js";
import { selectImportantFiles } from "../utils/fileSelector.js";
import { generateRepoAnalysis } from "./aiAnalysis.service.js";
import { Analysis } from "../models/analysis.model.js";
import { markStageFailed } from "./repoStatus.service.js";
import { logger } from "../utils/logger.js";

async function analyzeRepoWithAIInternal(repoId) {
  try {
    // 🟡 Set AI status to processing
    await Repo.findByIdAndUpdate(repoId, { aiStatus: "processing" });

    const repo = await Repo.findById(repoId);
    if (!repo) throw new Error("Repo not found");

    const files = await File.find({ repo: repoId });

    if (!files || files.length === 0) throw new Error("No files for analysis");

    const repoContentText = selectImportantFiles(files);
    logger.info("🧠 Selected important files length:", repoContentText.length);

    const analysisData = await generateRepoAnalysis(repoContentText);

    // Re-analysis replaces the previous result instead of accumulating
    await Analysis.deleteMany({ repo: repoId });

    // Save in Analysis collection
    const analysis = await Analysis.create({
      repo: repoId,
      summary: analysisData.summary,
      architecture: analysisData.architecture,
      complexity: analysisData.complexity,
      potentialIssues: analysisData.potentialIssues,
    });

    repo.aiAnalysis = analysis;
    await repo.save();

    // 🟢 Mark success
    await Repo.findByIdAndUpdate(repoId, { aiStatus: "ready" });
    logger.info("🎯 AI analysis completed successfully");
  } catch (error) {
    logger.error("AI analysis error:", error.message);

    // 🔴 Mark failure
    await markStageFailed(
      repoId,
      "ai",
      "Could not generate the AI analysis. Please try again."
    );
  }
}

export { analyzeRepoWithAIInternal };
