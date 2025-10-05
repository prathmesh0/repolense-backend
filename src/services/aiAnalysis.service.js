// services/aiAnalysis.service.js
import Groq from "groq-sdk";
import { ApiError } from "../utils/apiError.js";
import { jsonrepair } from "jsonrepair";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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
    // Return fallback (as before)
    return {
      summary: "Parsing failed",
      architecture: "Unknown",
      complexity: "Medium",
      potentialIssues: [text.slice(0, 500)],
    };
  }
};

export const generateRepoAnalysis = async (repoContentText) => {
  const prompt = `
Respond ONLY with one valid JSON object, NO extra text, markdown, headers, or multiple blocks.
{
  "summary": "...",
  "architecture": "...",
  "complexity": "Low" | "Medium" | "High",
  "potentialIssues": ["...", "..."]
}
Repository code:
${repoContentText}
`;

  try {
    console.log("⚡ Using Groq: llama-4-maveric");
    const response = await groq.chat.completions.create({
      model: "meta-llama/llama-4-maverick-17b-128e-instruct",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });
    let text = response.choices[0]?.message?.content?.trim();
    return betterParseJSON(text);
  } catch (error) {
    console.error("❌ Groq failed:", error.message);
    throw new ApiError(500, "Groq failed to generate AI analysis");
  }
};
