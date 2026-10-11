# Cleanup Phase 4: What Changed

Branch: `chore/phase-4-cleanup`

| Area | Before | After |
|---|---|---|
| **Prompt injection** (A4) | Repo files and the user's question were pasted into one prompt together with the instructions, so a file saying "ignore previous instructions" competed with the real ones. | Instructions are a system message. Repo content and the question go in a user message inside `<repository_content>` / `<user_question>` tags, and the system message says that text is data. Any tag in the content that tries to close or reopen the block is replaced by `[removed tag]`. The chat prompt also tells the model to say "not found" instead of guessing. (`utils/prompt.js`) |
| **LLM calls and timeouts** (C3) | Two separate Groq clients with default settings. | One client in `services/llm.service.js`: 45 second timeout per attempt and 2 automatic retries on 429/5xx/timeouts. |
| **GitHub calls and retries** (C3) | Two separate Octokit clients with no retry or timeout. | One shared client in `services/github.client.js` with the retry and throttling plugins and a 20 second timeout. It waits out short rate limits (30 seconds or less, once) and fails fast on longer ones, which the status system then reports. |
| **Model name** (C4) | `llama-3.3-70b-versatile` hard-coded in several places, and a log line that named a different model. | `LLM_MODEL` environment variable with the same default, defined in one place. |
| **Logging** (C5) | 33 `console.*` calls, including ones that printed the full AI response, retrieved code context and Groq responses. | pino logger (`utils/logger.js`), levels via `LOG_LEVEL`, readable output in development and JSON in production. Logs that dumped AI output or repository content were removed. |
| **Env loading** | `.env` was loaded after the other modules had been imported. | `src/index.js` imports `dotenv/config` first. |
| **Dead code and naming** (C6) | Unused `Query` model and `chunkArray` helper; file named `getBasicAIAnlaysis.js`. | Unused files deleted; file renamed to `getBasicAIAnalysis.js`. |
| **Scripts** | `npm start` ran `node index.js`, which does not exist. | `npm start` runs `node src/index.js`; `main` fixed. Added `test`, `test:watch` and `purge:sensitive`. |
| **Health check** (C7) | Always answered `201` and did not look at the database. | Pings MongoDB: `200` with `database: "up"`, or `503` with `DEGRADED` when it is down. |
| **Lockfiles** | `package-lock.json`, `yarn.lock` etc. were downloaded, stored and embedded (a 140 KB lockfile became dozens of useless chunks). | Lockfiles at any depth are skipped for download and embedding. |
| **Old stored secrets** | Data stored before Phase 1 could still contain `.env` content or keys. | `scripts/purge-sensitive-data.js`: dry run by default; `--apply` deletes files at credential paths (with their embeddings) and redacts keys inside other files and embedding previews. |
| **Tests** (C7) | None. | Vitest suite: 64 tests in 9 files (see below). |
| **CLAUDE.md** | Described the pre-Phase-1 code. | Rewritten for the current architecture, commands and gotchas. |

## Tests

- **Unit:** secret detection and redaction, file filters (incl. lockfiles), prompt wrapping and tag stripping, intent detection, chunking, cosine similarity, progress percent, user-facing error mapping, and that the analysis prompt keeps instructions in the system message and turns LLM failures into a sanitised error.
- **Integration** (real in-memory MongoDB, mocked GitHub and LLM, no network):
  - HTTP routes through the real app with `supertest`: login required, owner can read, another user gets 404, bad ids get 400, chat input validation, read-only history, operator-object rejection on login and register, httpOnly cookies, CORS allow-list, health check, and rate limiting returning 429.
  - Ingestion: one tree call, only indexable files stored, key inside a file redacted, full tree kept for the UI, a failing download skipped, re-analysis replaces files, extraction failure fails all three stages with reasons and creates no embeddings, embedding progress and no duplicates, and the stuck-repo sweep.
- I checked that the tests can fail: removing the ownership check from the route and the lockfile rule each made the relevant tests fail, and both were restored.
- The purge script was run against a seeded database: the dry run changed nothing, and `--apply` removed the `.env` record and its embeddings and redacted the key.

## Notes

- Nothing here changes the API responses, except the health check status codes. The frontend needs no changes.
- Integration tests download a MongoDB binary on first run (set `MONGOMS_SYSTEM_BINARY` to reuse one).
- Run `npm run purge:sensitive` (dry run) against your production database, review the output, then add `-- --apply`.
- The purge script does not touch saved chat messages, which could quote text the model saw earlier.
- Not done here: the vector search move, job queue, shared snapshots, chat memory and streaming, and the changes that need the frontend (typed chat messages, cookie-only auth).
