# Chat Phase 6: Memory and Streaming

Branch: `feat/phase-6-chat-memory-streaming` (not committed yet)

## 1. Conversation memory

| Area | Before | After |
|---|---|---|
| **Context** | Every question was answered alone. "Explain that more" had no meaning to the model. | The last 6 stored messages (3 exchanges) go to the model as earlier turns. Each is cut at 1,500 characters. |
| **Search for short follow-ups** | The follow-up text alone was embedded, so retrieval found unrelated code. | A question under 8 words is searched together with the previous user question. No extra LLM call. |
| **Prompt safety** | n/a | Earlier user messages are wrapped as untrusted data like the current one, and tag-closing tricks are removed. Stored text is never trusted. |
| **Saving** | Load the chat, push two messages, `save()`. Two messages sent at once could overwrite each other. | One atomic `$push` with upsert. |

## 2. Streaming

`POST /api/v1/aiChat/chat/:repoId?stream=true` answers with `text/event-stream`. Without `stream=true` the endpoint behaves as before (same JSON), apart from memory.

| Event | Data | When |
|---|---|---|
| `sources` | `{sources: [paths]}` | first |
| `token` | `{text}` | many, as the model writes |
| `done` | `{chatId}` | after the full answer is saved |
| `error` | `{message}` | the model failed mid-answer (generic message, details only in logs) |

- Problems found before the model starts (no embeddings yet, bad question, not your repo) still return a normal JSON error with the usual status, so the client handles them as before.
- If the client disconnects, generation is aborted and nothing is saved. If the model fails mid-answer, nothing is saved either; the user can ask again.
- Greetings and thanks use the same stream with a canned answer and no model call.
- Headers disable proxy buffering (`X-Accel-Buffering: no`, `no-transform`). The app has no compression middleware, which would also buffer.

Frontend note (for later): `EventSource` only supports GET, so read the stream with `fetch` and `response.body.getReader()`, splitting on blank lines.

## Files

- Changed: `src/services/llm.service.js` (`history`, `askLLMStream`), `src/services/chat.service.js` (shared preparation, `buildHistory`, `retrievalQuery`, `chatWithRepoStream`), `src/controllers/chat.controller.js`
- Tests: `tests/integration/chatMemory.test.js` (8), `tests/unit/chat.test.js` (+2)

## Verification

- 97 tests pass (10 new). Lint passes.
- Removing memory from the prompt fails 2 tests; leaking the raw error in the stream fails 1; both restored.

## Not verified

- A real Groq stream (the model is mocked). The call follows the SDK's `stream: true` + `signal` option.
- Behaviour through Render's proxy under real network conditions. Check that tokens arrive gradually, not all at once.
- Aborting an in-flight Groq request on disconnect.

## Notes

- The chat is still one document with a growing messages array (backlog B7).
- Streaming is opt-in, so the current frontend keeps working unchanged.
