import { pipeline } from "@xenova/transformers";
import { Embedding } from "../models/embedding.model.js";
import { cosineSimilarity } from "../utils/cosineSimilarity.js";
import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
let embeddingModel = null;

async function loadEmbeddingModel() {
  if (!embeddingModel) {
    console.log("⏳ Loading embedding model: all-MiniLM-L6-v2 ...");
    embeddingModel = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2"
    );
    console.log("✅ Embedding model loaded for chat!");
  }
  return embeddingModel;
}

export const chatWithRepo = async (repoId, question) => {
  // Load embedding model
  const model = await loadEmbeddingModel();

  //   Generate Embedding for question
  const output = await model(question, { pooling: "mean", normalize: true });
  const queryVector = Array.from(output.data);

  // 3️⃣ Fetch embeddings for this repo
  const allEmbeddings = await Embedding.find({ repo: repoId });
  if (!allEmbeddings.length) throw new Error("No embeddings found for repo");

  // 4️⃣ Compute similarity scores
  const scored = allEmbeddings.map((e) => ({
    path: e.path,
    contentPreview: e.contentPreview,
    vector: e.vector,
    score: cosineSimilarity(queryVector, e.vector),
  }));

  // 5️⃣ Pick top 5
  const top = scored.sort((a, b) => b.score - a.score).slice(0, 5);
  const context = top
    .map(
      (t, i) =>
        `File ${i + 1}: ${t.path}\nContent Preview:\n${t.contentPreview}\n\n`
    )
    .join("");

  // 6️⃣ Build LLM prompt
  const prompt = `
You are an AI assistant analyzing a GitHub repository.

Use the given context (code + metadata) to answer in simple, human-readable language.

Context:
${context}

Question: "${question}"

If metadata-related (e.g. repo name, owner, contributors, languages), rely on REPO_METADATA.
If code-related, use the most relevant snippets.
`;

  // 7️⃣ Query Groq
  const response = await groq.chat.completions.create({
    model: "meta-llama/llama-4-maverick-17b-128e-instruct",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
  });

  const answer = response.choices[0]?.message?.content?.trim();

  return {
    answer,
    sources: top.map((t) => t.path),
  };
};
