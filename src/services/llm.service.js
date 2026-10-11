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
// `history` is an optional list of earlier {role, content} turns (user turns
// must already be wrapped).
const buildMessages = ({ system, user, history = [] }) => [
  { role: "system", content: system },
  ...history,
  { role: "user", content: user },
];

export async function askLLM({ system, user, history, temperature = 0.3 }) {
  const response = await groq.chat.completions.create({
    model: LLM_MODEL,
    temperature,
    messages: buildMessages({ system, user, history }),
  });
  return response.choices[0]?.message?.content?.trim() ?? "";
}

// Yields the answer piece by piece. Pass an AbortSignal to stop generation
// (for example when the client disconnects).
export async function* askLLMStream({
  system,
  user,
  history,
  temperature = 0.3,
  signal,
}) {
  const stream = await groq.chat.completions.create(
    {
      model: LLM_MODEL,
      temperature,
      stream: true,
      messages: buildMessages({ system, user, history }),
    },
    { signal }
  );
  for await (const chunk of stream) {
    const piece = chunk.choices?.[0]?.delta?.content;
    if (piece) yield piece;
  }
}
