import { Embedding } from "../models/embedding.model.js";
import { cosineSimilarity } from "../utils/cosineSimilarity.js";
import Groq from "groq-sdk";
import { embedText } from "./embeddingModel.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Cheap local intent check. This used to be an extra LLM call on every
// message; anything that isn't purely a greeting or a thank-you is a QUERY.
const GREETING_RE =
  /^(hi+|hello+|hey+|hola|yo|sup|greetings|good\s+(morning|afternoon|evening))(\s+(there|repolens|team|everyone))?\s*[!.,]*$/i;
const ACKNOWLEDGEMENT_RE =
  /^(ok(ay)?|k|thanks?( you)?|thank you( so much)?|thx|ty|got it|cool|great|nice|awesome|perfect|alright|understood|makes sense)(\s+(thanks?|thank you))?\s*[!.,]*$/i;

function classifyIntent(userMessage) {
  const text = userMessage.trim();
  if (GREETING_RE.test(text)) return "GREETING";
  if (ACKNOWLEDGEMENT_RE.test(text)) return "ACKNOWLEDGEMENT";
  return "QUERY";
}

export const chatWithRepo = async (repoId, question) => {
  // Classify intent first
  const intent = classifyIntent(question);

  if (intent === "GREETING") {
    // Static response for greetings
    return {
      answer:
        "Hi! I'm Repolens. Excited to help you explore and understand your repository.",
      sources: [],
    };
  } else if (intent === "ACKNOWLEDGEMENT") {
    // Static response for acknowledgements
    return {
      answer:
        "Thanks for acknowledging! Just let me know what you’d like to explore next.",
      sources: [],
    };
  }
  // Otherwise treat as QUERY or mixed, run the existing flow

  //   Generate Embedding for question
  const queryVector = await embedText(question);

  // 3️⃣ Fetch embeddings for this repo
  const allEmbeddings = await Embedding.find(
    { repo: repoId },
    "path chunkIndex contentPreview vector"
  ).lean();
  if (!allEmbeddings.length) throw new Error("No embeddings found for repo");

  // 4️⃣ Compute similarity scores
  const scored = allEmbeddings.map((e) => ({
    path: e.path,
    chunkIndex: e.chunkIndex,
    contentPreview: e.contentPreview,
    vector: e.vector,
    score: cosineSimilarity(queryVector, e.vector),
  }));

  // console.log("Scored", scored);

  // 5️⃣ Pick top 5
  const top = scored.sort((a, b) => b.score - a.score).slice(0, 5);
  const context = top
    .map(
      (t, i) =>
        `File ${i + 1}: ${t.path}\nContent Preview:\n${t.contentPreview}\n\n`
    )
    .join("");

  console.log("context", context);

  // 6️⃣ Build LLM prompt
  const prompt = `
You are an AI assistant analyzing a GitHub repository.
Use the provided context (code + metadata) to answer clearly and concisely in plain English.

Context:
${context}

Question: "${question}"

If it concerns code, focus on the most relevant snippets.
If the question concerns metadata (repo name, owner, contributors, languages), use REPO_METADATA.
`;

  // 7️⃣ Query Groq
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
  });

  const answer = response.choices[0]?.message?.content?.trim();

  return {
    answer,
    sources: top.map((t) => t.path),
  };
};
