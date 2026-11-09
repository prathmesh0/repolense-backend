// services/aiAnalysis.service.js
import { ApiError } from "../utils/apiError.js";
import { jsonrepair } from "jsonrepair";
import { askLLM } from "./llm.service.js";
import { UNTRUSTED_NOTICE, wrapUntrusted } from "../utils/prompt.js";
import { logger } from "../utils/logger.js";

const requireSummary = (summary) => {
  if (typeof summary !== "string" || !summary.trim()) {
    throw new Error("Analysis has no summary");
  }
  return summary.trim();
};

const betterParseJSON = (text) => {
  try {
    // Remove headers/anchors if present
    text = text
      .replace(/<\|header_start\|>/g, "")
      .replace(/<\|header_end\|>/g, "");

    // Extract substring between first '{' and last '}'
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first === -1 || last === -1) throw new Error("No JSON object found");

    let block = text.slice(first, last + 1);

    // Attempt to repair malformed JSON, if necessary
    block = jsonrepair(block);

    const parsed = JSON.parse(block);

    // Standard sanitizer as before
    // (same logic as in your safeParseJSON)

    return {
      summary: requireSummary(parsed.summary),
      architecture:
        typeof parsed.architecture === "string"
          ? parsed.architecture.trim()
          : "Unknown",
      complexity: ["Low", "Medium", "High"].includes(parsed.complexity)
        ? parsed.complexity
        : "Medium",
      potentialIssues: Array.isArray(parsed.potentialIssues)
        ? [
            ...new Set(
              parsed.potentialIssues
                .filter((x) => typeof x === "string")
                .map((x) => x.trim())
            ),
          ]
        : [],
    };
  } catch (err) {
    // Do not store a placeholder as if it were a real result: the caller
    // marks the stage failed so the user can retry.
    logger.error("Could not parse the AI analysis: %s", err.message);
    throw new Error("Unusable AI analysis response");
  }
};

const ANALYSIS_SYSTEM_PROMPT = `You analyse source code repositories.
The repository text starts with a file tree, followed by the most important files (long files may be cut and marked [truncated]). Base your answer on it.
Respond ONLY with one valid JSON object: no extra text, markdown, headers, or multiple blocks.
Shape:
{
  "summary": "...",
  "architecture": "...",
  "complexity": "Low" | "Medium" | "High",
  "potentialIssues": ["...", "..."]
}
${UNTRUSTED_NOTICE}`;

export const generateRepoAnalysis = async (repoContentText) => {
  if (typeof repoContentText !== "string" || !repoContentText.trim()) {
    throw new ApiError(422, "No repository content to analyse");
  }
  try {
    const text = await askLLM({
      system: ANALYSIS_SYSTEM_PROMPT,
      user: wrapUntrusted("repository_content", repoContentText),
      temperature: 0.3,
    });
    return betterParseJSON(text);
  } catch (error) {
    logger.error("❌ LLM analysis failed:", error.message);
    throw new ApiError(500, "Groq failed to generate AI analysis");
  }
};
