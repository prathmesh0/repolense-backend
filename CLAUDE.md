# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start with nodemon (entry `src/index.js`); `npm start` runs the same entry without nodemon
- `npm test` — Vitest (unit + integration); `npm run test:watch` for watch mode. Run one file with `npx vitest run tests/unit/secrets.test.js`
- `npm run lint` — ESLint with `--fix`; `npm run format` — Prettier write
- `npm run purge:sensitive` — one-off cleanup of stored credential files/keys (dry run by default, `-- --apply` to change data)

Integration tests start an in-memory MongoDB (`mongodb-memory-server`), which downloads a `mongod` binary on first run. Set `MONGOMS_SYSTEM_BINARY` to reuse an existing one. GitHub is mocked in tests; no network or API keys needed.

Environment (`.env`, loaded first thing in `src/index.js`): `PORT`, `MONGODB_URI` (DB name `repolense` is appended in `src/db/index.js`), `ACCESS_TOKEN_SECRET`/`ACCESS_TOKEN_EXPIRY`, `REFRESH_TOKEN_SECRET`/`REFRESH_TOKEN_EXPIRY`, `GROQ_API_KEY`, `GITHUB_TOKEN` (strongly recommended: 60 requests/hour without it), `CORS_ORIGIN`, optional `LLM_MODEL` (default `llama-3.3-70b-versatile`) and `LOG_LEVEL`.

## Architecture

Express 5 + Mongoose ESM API ("RepoLens") that ingests a GitHub repo, analyses it with an LLM, and supports RAG chat over it. Routes are mounted in `src/app.js` under `/api/v1/{users,repository,aiChat,health}`; layering is routes → controllers → services, with `asyncHandler`, `ApiError`, `ApiResponse` in `src/utils` and a final `errorHandler`. Auth is JWT (`verifyJWT`, access/refresh tokens, httpOnly cookies and `Authorization` header).

### Access control and abuse protection
- Every repo-scoped route runs `verifyJWT` then `requireOwnedRepo` (`middlewares/ownership.middleware.js`), which loads the repo into `req.repo` only if it belongs to the user (foreign or missing ids both return 404). Controllers use `req.repo`, never `req.params` to look repos up.
- `middlewares/rateLimit.middleware.js`: global, auth, analyse and chat limiters (per user when logged in, else per IP; `trust proxy` is set).
- CORS is an exact allow-list in `app.js` (`CORS_ORIGIN`, the Vercel frontend, localhost:3000).
- Logging goes through `utils/logger.js` (pino). Never log repository content or prompts.

### Repo ingestion pipeline
`controllers/repo.controller.js` `analyseRepo` fetches GitHub metadata, upserts a per-user `Repo` (unique `url + user`), resets progress/errors, returns `201` immediately and starts `runAnalysisPipeline` (`services/analysisPipeline.service.js`) without awaiting it. If an analysis is already running (a stage is `processing` and updated within `STALE_PROCESSING_MS`), it returns the existing repo with `200` instead.

Pipeline: `extractFileStructureInternal` → only if it returned `true`, `analyzeRepoWithAIInternal` and `generateEmbeddingsForRepo` run in parallel. If extraction fails, the AI and embedding stages are marked `failed` (never run).
- File extraction (`services/fileStructure.service.js`): one `git.getTree` call for the whole tree (saved on `Repo.fileStructure`), then only files passing `shouldIndexFile` (`utils/fileFilters.js`: no ignored folders, credential files, lockfiles, binaries, files over 200 KB, max 1500 files) are downloaded 8 at a time and stored in `File` with secrets redacted. Re-runs delete old `File`/`Embedding`/`Analysis` documents first.
- Embeddings (`services/embed.service.js`): 1024-char chunks with 30% overlap, embedded one at a time (batching the model gave no CPU speedup and shifted vectors), written with `insertMany` in batches.
- Status model on `Repo`: `fileStructureStatus` / `aiStatus` / `embeddingStatus` (pending/processing/ready/failed), `progress.{fileStructure,embedding}` `{done,total}`, and user-safe `statusErrors.{fileStructure,ai,embedding}`. `services/repoStatus.service.js` owns `markStageFailed`, `reportProgress`, `computeProgress` and the stuck-repo sweeper (started in `src/index.js`; fails stages left `processing` after a restart or crash). Progress writes also refresh `updatedAt`, which the sweep and the in-progress guard rely on.
- The client polls `GET /repository/getRepoInfo/:repoId?info=basicAnalysis|fileStructure|aiAnalysis`, which returns `statuses`, `progress` and `statusErrors`.

### AI / RAG
- All LLM calls go through `services/llm.service.js` (`askLLM`: model from `LLM_MODEL`, 45 s timeout, 2 SDK retries). Instructions go in the system message; repository text and user questions are untrusted and must be wrapped with `wrapUntrusted()` (`utils/prompt.js`), which also strips attempts to close the tag.
- GitHub calls use the shared client in `services/github.client.js` (retry + throttling plugins, 20 s timeout). Tests mock this module.
- Embeddings use `@xenova/transformers` (`Xenova/all-MiniLM-L6-v2`) via the shared loader in `services/embeddingModel.js`.
- Chat (`services/chat.service.js`): a local regex decides GREETING / ACKNOWLEDGEMENT (canned replies) vs QUERY. For QUERY it embeds the question, brute-force cosine-scores every `Embedding` of the repo in memory (no vector DB), and sends the top 5 chunks to the LLM. History is stored in the `Chat` model (one document per repo, messages array).
- Analysis output is parsed leniently (`jsonrepair` + sanitising in `services/aiAnalysis.service.js`).

## Gotchas
- `getRepoInfo` still appends a fake user message and a JSON dump of the response to the chat history. The frontend rebuilds its cards from those messages, so removing this must ship together with a frontend change.
- Credential-file and secret handling lives in `utils/secrets.js`; use `isSensitivePath` / `redactSecrets` whenever new code stores or sends repo content.
- `express.json` body limit is 16kb.
- Prettier on this Windows checkout can rewrite line endings across files; run it only on the files you changed.
- Phase write-ups with before/after details: `SECURITY_PHASE1.md`, `PERFORMANCE_PHASE2.md`, `STATUS_PHASE3.md`, `CLEANUP_PHASE4.md`. The full backlog is in `IMPROVEMENTS.md`.
