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

async function classifyIntent(userMessage) {
  const classifyPrompt = `
You have to classify the following message into one of these intents ONLY: GREETING, ACKNOWLEDGEMENT, QUERY.

Examples of GREETING: hi, hello, hey, greetings
Examples of ACKNOWLEDGEMENT: ok, thanks, got it, thank you
Examples of QUERY: all other messages including questions and mixed messages

Message: "${userMessage}"

Return just the intent label in uppercase.
`;

  const classificationResponse = await groq.chat.completions.create({
    model: "meta-llama/llama-4-maverick-17b-128e-instruct",
    messages: [{ role: "user", content: classifyPrompt }],
  });

  console.log(classificationResponse);

  return classificationResponse.choices[0]?.message?.content
    ?.trim()
    .toUpperCase();
}

export const chatWithRepo = async (repoId, question) => {
  // Classify intent first
  const intent = await classifyIntent(question);

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
