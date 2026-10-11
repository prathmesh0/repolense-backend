import { findSimilarChunks } from "./retrieval.service.js";
import { embedText } from "./embeddingModel.js";
import { askLLM, askLLMStream } from "./llm.service.js";
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
Earlier turns of the conversation are included for continuity; use them to resolve references like "that file" or "it", but base facts on the current repository context.
${UNTRUSTED_NOTICE}`;

const GREETING_ANSWER =
  "Hi! I'm Repolens. Excited to help you explore and understand your repository.";
const ACKNOWLEDGEMENT_ANSWER =
  "Thanks for acknowledging! Just let me know what you’d like to explore next.";

// Conversation memory limits: the last few turns, each capped, so the prompt
// stays small and a long chat cannot blow the model's context.
export const HISTORY_MAX_MESSAGES = 6;
export const HISTORY_MAX_CHARS = 1500;
// A follow-up this short ("explain more", "why?") has no searchable meaning
// of its own, so retrieval also looks at the previous question.
const SHORT_FOLLOWUP_WORDS = 8;

const clip = (text) =>
  text.length > HISTORY_MAX_CHARS
    ? `${text.slice(0, HISTORY_MAX_CHARS)}…`
    : text;

// Turns stored messages into LLM turns. User turns are untrusted data, so
// they are wrapped the same way as the current question.
export function buildHistory(messages = []) {
  return messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .slice(-HISTORY_MAX_MESSAGES)
    .map((m) =>
      m.role === "user"
        ? {
            role: "user",
            content: wrapUntrusted("user_question", clip(m.content)),
          }
        : { role: "assistant", content: clip(m.content) }
    );
}

export function retrievalQuery(question, messages = []) {
  const words = question.trim().split(/\s+/).length;
  if (words >= SHORT_FOLLOWUP_WORDS) return question;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  return lastUser ? `${lastUser.content}\n${question}` : question;
}

// Shared by the normal and streaming paths. Returns either a canned answer
// or everything needed to call the LLM.
async function prepareChat(repoId, question, messages) {
  const intent = classifyIntent(question);
  if (intent === "GREETING") return { canned: GREETING_ANSWER };
  if (intent === "ACKNOWLEDGEMENT") return { canned: ACKNOWLEDGEMENT_ANSWER };

  const queryVector = await embedText(retrievalQuery(question, messages));

  // Find the 5 most similar chunks (Atlas vector search, or in-memory fallback)
  const top = await findSimilarChunks(repoId, queryVector, 5);
  if (!top.length) throw new Error("No embeddings found for repo");

  const context = top
    .map(
      (t, i) =>
        `File ${i + 1}: ${t.path}\nContent Preview:\n${t.contentPreview}\n\n`
    )
    .join("");

  // Instructions live in the system message; repository text and the
  // question are untrusted data.
  return {
    sources: top.map((t) => t.path),
    llm: {
      system: CHAT_SYSTEM_PROMPT,
      history: buildHistory(messages),
      user: `${wrapUntrusted("repository_content", context)}

${wrapUntrusted("user_question", question)}`,
      temperature: 0.4,
    },
  };
}

// `messages` = earlier stored messages of this chat (oldest first).
export const chatWithRepo = async (repoId, question, messages = []) => {
  const prepared = await prepareChat(repoId, question, messages);
  if (prepared.canned) return { answer: prepared.canned, sources: [] };

  const answer = await askLLM(prepared.llm);
  return { answer, sources: prepared.sources };
};

// Streaming variant. Yields {type: "sources", sources} first, then
// {type: "token", text} pieces. Retrieval errors throw before anything is yielded.
export async function* chatWithRepoStream(
  repoId,
  question,
  messages = [],
  signal
) {
  const prepared = await prepareChat(repoId, question, messages);
  if (prepared.canned) {
    yield { type: "sources", sources: [] };
    yield { type: "token", text: prepared.canned };
    return;
  }

  yield { type: "sources", sources: prepared.sources };
  for await (const text of askLLMStream({ ...prepared.llm, signal })) {
    yield { type: "token", text };
  }
}
