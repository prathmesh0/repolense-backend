import Groq from "groq-sdk";

// Single place for the model name and client settings
export const LLM_MODEL = process.env.LLM_MODEL || "llama-3.3-70b-versatile";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
  timeout: 45_000, // per attempt
  maxRetries: 2, // SDK retries 429/5xx/timeouts with backoff
});

// Instructions go in the system message; repository text and user input are
// passed in `user` and must already be wrapped with wrapUntrusted().
export async function askLLM({ system, user, temperature = 0.3 }) {
  const response = await groq.chat.completions.create({
    model: LLM_MODEL,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return response.choices[0]?.message?.content?.trim() ?? "";
}
