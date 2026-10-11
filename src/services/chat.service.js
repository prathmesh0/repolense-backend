import { findSimilarChunks } from "./retrieval.service.js";
import { embedText } from "./embeddingModel.js";
import { askLLM } from "./llm.service.js";
import { UNTRUSTED_NOTICE, wrapUntrusted } from "../utils/prompt.js";

// Cheap local intent check. This used to be an extra LLM call on every
// message; anything that isn't purely a greeting or a thank-you is a QUERY.
const GREETING_RE =
  /^(hi+|hello+|hey+|hola|yo|sup|greetings|good\s+(morning|afternoon|evening))(\s+(there|repolens|team|everyone))?\s*[!.,]*$/i;
const ACKNOWLEDGEMENT_RE =
  /^(ok(ay)?|k|thanks?( you)?|thank you( so much)?|thx|ty|got it|cool|great|nice|awesome|perfect|alright|understood|makes sense)(\s+(thanks?|thank you))?\s*[!.,]*$/i;

export function classifyIntent(userMessage) {
  const text = userMessage.trim();
  if (GREETING_RE.test(text)) return "GREETING";
  if (ACKNOWLEDGEMENT_RE.test(text)) return "ACKNOWLEDGEMENT";
  return "QUERY";
}

const CHAT_SYSTEM_PROMPT = `You are an AI assistant analysing a GitHub repository.
Answer clearly and concisely in plain English using only the provided repository context (code and metadata).
If the context does not contain the answer, say you could not find it in the repository instead of guessing.
If the question concerns code, focus on the most relevant snippets.
If it concerns metadata (repo name, owner, contributors, languages), use the REPO_METADATA entry.
${UNTRUSTED_NOTICE}`;

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

  // 3️⃣ Find the 5 most similar chunks (Atlas vector search, or in-memory fallback)
  const top = await findSimilarChunks(repoId, queryVector, 5);
  if (!top.length) throw new Error("No embeddings found for repo");

  const context = top
    .map(
      (t, i) =>
        `File ${i + 1}: ${t.path}\nContent Preview:\n${t.contentPreview}\n\n`
    )
    .join("");

  // 6️⃣ Ask the LLM. Instructions live in the system message; repository
  // text and the question are untrusted data.
  const answer = await askLLM({
    system: CHAT_SYSTEM_PROMPT,
    user: `${wrapUntrusted("repository_content", context)}

${wrapUntrusted("user_question", question)}`,
    temperature: 0.4,
  });

  return {
    answer,
    sources: top.map((t) => t.path),
  };
};
