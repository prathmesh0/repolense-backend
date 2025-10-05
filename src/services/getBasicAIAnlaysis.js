import { File } from "../models/file.model.js";
import { Repo } from "../models/repo.model.js";
import { selectImportantFiles } from "../utils/fileSelector.js";
import { generateRepoAnalysis } from "./aiAnalysis.service.js";
import { Analysis } from "../models/analysis.model.js";

async function analyzeRepoWithAIInternal(repoId) {
  try {
    // 🟡 Set AI status to processing
    await Repo.findByIdAndUpdate(repoId, { aiStatus: "processing" });

    const repo = await Repo.findById(repoId);
    if (!repo) throw new Error("Repo not found");

    const files = await File.find({ repo: repoId });

    if (!files || files.length === 0) throw new Error("No files for analysis");

    const repoContentText = selectImportantFiles(files);
    console.log("🧠 Selected important files length:", repoContentText.length);

    const analysisData = await generateRepoAnalysis(repoContentText);
    console.log("✅ AI Response:", analysisData);

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
    console.log("🎯 AI analysis completed successfully");
  } catch (error) {
    console.error("AI analysis error:", error.message);

    // 🔴 Mark failure
    await Repo.findByIdAndUpdate(repoId, { aiStatus: "failed" });
  }
}

export { analyzeRepoWithAIInternal };
