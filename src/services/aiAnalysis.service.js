// services/aiAnalysis.service.js
import { ApiError } from "../utils/apiError.js";
import { jsonrepair } from "jsonrepair";
import { askLLM } from "./llm.service.js";
import { UNTRUSTED_NOTICE, wrapUntrusted } from "../utils/prompt.js";
import { logger } from "../utils/logger.js";

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
      summary:
        typeof parsed.summary === "string"
          ? parsed.summary.trim()
          : "No summary",
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
    logger.error("Error details:", err);
    // Return fallback (as before)
    return {
      summary: "Parsing failed",
      architecture: "Unknown",
      complexity: "Medium",
      potentialIssues: [text.slice(0, 500)],
    };
  }
};

const ANALYSIS_SYSTEM_PROMPT = `You analyse source code repositories.
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
