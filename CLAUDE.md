# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start with nodemon (entry `src/index.js`); `npm start` runs the same entry without nodemon
- `npm test` — Vitest (unit + integration); `npm run test:watch` for watch mode. Run one file with `npx vitest run tests/unit/secrets.test.js`
- `npm run lint` — ESLint with `--fix`; `npm run format` — Prettier write
- `npm run worker` — standalone job worker (no HTTP). Run the web server with `RUN_WORKER=false` to keep embedding off the request-serving process
- `npm run create:vector-index` — creates the Atlas vector search index (Atlas only; see Retrieval below)
- `npm run migrate:chat` — moves old-format chat messages into `ChatMessage` (dry run by default, `-- --apply` to change data; also done lazily by the app)
- `npm run purge:fake-chat` — deletes the old label/JSON-dump chat messages (dry run by default, `-- --apply` to change data)
- `npm run purge:sensitive` — one-off cleanup of stored credential files/keys (dry run by default, `-- --apply` to change data)

Integration tests start an in-memory MongoDB (`mongodb-memory-server`), which downloads a `mongod` binary on first run. Set `MONGOMS_SYSTEM_BINARY` to reuse an existing one. GitHub is mocked in tests; no network or API keys needed.

Environment (`.env`, loaded first thing in `src/index.js`): `PORT`, `MONGODB_URI` (DB name `repolense` is appended in `src/db/index.js`), `ACCESS_TOKEN_SECRET`/`ACCESS_TOKEN_EXPIRY`, `REFRESH_TOKEN_SECRET`/`REFRESH_TOKEN_EXPIRY`, `GROQ_API_KEY`, `GITHUB_TOKEN` (strongly recommended: 60 requests/hour without it), `CORS_ORIGIN`, `COOKIE_SAMESITE`/`COOKIE_SECURE` (optional), optional `LLM_MODEL` (default `openai/gpt-oss-120b`; Groq retires models, so check `GET https://api.groq.com/openai/v1/models` if calls fail with `model_not_found`), `LOG_LEVEL`, `RUN_WORKER` (default true), `JOB_CONCURRENCY` (default 1), `VECTOR_SEARCH` (`auto`|`atlas`|`memory`, default `auto`) and `VECTOR_INDEX_NAME`.

## Architecture

Express 5 + Mongoose ESM API ("RepoLens") that ingests a GitHub repo, analyses it with an LLM, and supports RAG chat over it. Routes are mounted in `src/app.js` under `/api/v1/{users,repository,aiChat,health}`; layering is routes → controllers → services, with `asyncHandler`, `ApiError`, `ApiResponse` in `src/utils` and a final `errorHandler`. Auth is JWT (`verifyJWT`, access/refresh tokens, httpOnly cookies and `Authorization` header).

### Access control and abuse protection
- Every repo-scoped route runs `verifyJWT` then `requireOwnedRepo` (`middlewares/ownership.middleware.js`), which loads the repo into `req.repo` only if it belongs to the user (foreign or missing ids both return 404). Controllers use `req.repo`, never `req.params` to look repos up.
- `middlewares/rateLimit.middleware.js`: global, auth, analyse and chat limiters (per user when logged in, else per IP; `trust proxy` is set).
- CORS is an exact allow-list in `app.js` (`CORS_ORIGIN`, the Vercel frontend, localhost:3000).
- Logging goes through `utils/logger.js` (pino). Never log repository content or prompts.

### Repo ingestion pipeline
`controllers/repo.controller.js` `analyseRepo` fetches GitHub metadata, upserts a per-user `Repo` (unique `url + user`), resets progress/errors, returns `201` immediately and enqueues a job (`services/jobQueue.service.js`). If the repo already has a queued or running job, it returns the existing repo with `200` instead (the `Job` model has a partial unique index on `repo` where `active: true`).

Job queue (MongoDB-backed, no Redis): a worker (in-process by default, or `npm run worker`) atomically claims the oldest queued job (`findOneAndUpdate`), up to `JOB_CONCURRENCY` at a time, and runs `runAnalysisPipeline`. A running job refreshes `lockedAt` every 30 s; if it goes 2 min without a heartbeat (crash, restart), `requeueStaleJobs` retries it (max 2 attempts) or fails it together with the repo's stages. Startup and the worker loop both run recovery. Graceful shutdown (SIGTERM/SIGINT) stops claiming and waits up to 25 s for running jobs. `getRepoInfo` returns `job: {status, position?, attempts}` while a job is live.

Pipeline (`services/analysisPipeline.service.js`): `extractFileStructureInternal` → only if it returned `true`, `analyzeRepoWithAIInternal` and `generateEmbeddingsForRepo` run in parallel. If extraction fails, the AI and embedding stages are marked `failed` (never run).
- File extraction (`services/fileStructure.service.js`): one `git.getTree` call for the whole tree (saved on `Repo.fileStructure`), then only files passing `shouldIndexFile` (`utils/fileFilters.js`: no ignored folders, credential files, lockfiles, binaries, files over 200 KB, max 1500 files) are downloaded 8 at a time and stored in `File` with secrets redacted. Re-runs delete old `File`/`Embedding`/`Analysis` documents first.
- Embeddings (`services/embed.service.js`): 1024-char chunks with 30% overlap, embedded one at a time (batching the model gave no CPU speedup and shifted vectors), written with `insertMany` in batches.
- Status model on `Repo`: `fileStructureStatus` / `aiStatus` / `embeddingStatus` (pending/processing/ready/failed), `progress.{fileStructure,embedding}` `{done,total}`, and user-safe `statusErrors.{fileStructure,ai,embedding}`. `services/repoStatus.service.js` owns `markStageFailed`, `reportProgress`, `computeProgress` and the stuck-repo sweeper, which fails stages left `processing` only for repos with no live job (the queue owns repos that have one). Progress writes also refresh `updatedAt`, which the sweep and the in-progress guard rely on.
- Progress can also be pushed: `GET /repository/status-stream/:repoId` (SSE, `status` / `done` / `error` events, DB checked every 1.5 s, 15 min cap, 5 streams per user). `GET /users/me` returns the logged-in user.
- The client polls `GET /repository/getRepoInfo/:repoId?info=basicAnalysis|fileStructure|aiAnalysis`, which returns `statuses`, `progress` and `statusErrors`.

### AI / RAG
- All LLM calls go through `services/llm.service.js` (`askLLM`: model from `LLM_MODEL`, 45 s timeout, 2 SDK retries). Instructions go in the system message; repository text and user questions are untrusted and must be wrapped with `wrapUntrusted()` (`utils/prompt.js`), which also strips attempts to close the tag.
- GitHub calls use the shared client in `services/github.client.js` (retry + throttling plugins, 20 s timeout). Tests mock this module.
- Embeddings use `@xenova/transformers` (`Xenova/all-MiniLM-L6-v2`) via the shared loader in `services/embeddingModel.js`.
- Chat (`services/chat.service.js`): a local regex decides GREETING / ACKNOWLEDGEMENT (canned replies) vs QUERY. For QUERY it embeds the question, gets the top 5 chunks from `services/retrieval.service.js`, and sends them to the LLM. The last 6 stored messages are sent as memory (user turns wrapped as untrusted); short follow-ups (under 8 words) are searched together with the previous question. `POST /aiChat/chat/:repoId?stream=true` streams SSE events (`sources`, `token`, `done`, `error`); errors before the model starts are normal JSON. History is saved only after a complete answer.
- Retrieval: uses Atlas `$vectorSearch` (index `embedding_vector_index`, 384 dims, cosine, filter on `repo`) and falls back to a streaming top-k scan in memory when Atlas or the index is unavailable, or when Atlas returns nothing yet (new vectors index asynchronously). After an Atlas error it skips Atlas for 5 minutes. Tests cover the fallback and the pipeline shape, not a real Atlas cluster. History is stored in the `ChatMessage` collection (one document per message; `Chat` is one document per repo with a summary). `services/chatHistory.service.js` owns reads/writes and migrates chats still in the old `messages`-array format on first access.
- Analysis output is parsed leniently (`jsonrepair` + sanitising in `services/aiAnalysis.service.js`).

## Gotchas
- `getRepoInfo` is read-only. It used to store a label and a JSON dump of its response in the chat history; old chats may still contain them (`npm run purge:fake-chat` removes them, `isFakeMessage` in `chatHistory.service.js` defines them).
- Auth cookies (`utils/authCookies.js`): httpOnly, `Secure`, `SameSite=Lax`, `Max-Age` = token expiry. `COOKIE_SAMESITE` (`lax`|`strict`|`none`) and `COOKIE_SECURE=false` (Safari on http localhost) override. Lax only works when the browser reaches the API through the frontend domain (Next.js `/api` rewrite). `verifyJWT` prefers an `Authorization` header over the cookie. Tokens are still returned in login/refresh bodies for older clients.
- Credential-file and secret handling lives in `utils/secrets.js`; use `isSensitivePath` / `redactSecrets` whenever new code stores or sends repo content.
- `express.json` body limit is 16kb.
- Prettier on this Windows checkout can rewrite line endings across files; run it only on the files you changed.
- Phase write-ups with before/after details: `SECURITY_PHASE1.md`, `PERFORMANCE_PHASE2.md`, `STATUS_PHASE3.md`, `CLEANUP_PHASE4.md`, `SCALE_PHASE5.md`, `CHAT_PHASE6.md`, `API_PHASE7.md`, `CONTRACT_PHASE8.md`. The full backlog is in `IMPROVEMENTS.md`.
