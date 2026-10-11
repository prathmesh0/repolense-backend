# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start with nodemon (`-r dotenv/config`, entry `src/index.js`)
- `npm run lint` — ESLint with `--fix`
- `npm run format` — Prettier write
- No test suite exists. `npm start` runs `node index.js` from the repo root, which doesn't exist (the entry is `src/index.js`), so use `npm run dev`.

Requires a `.env` (loaded from `./.env`) with: `PORT`, `MONGODB_URI` (DB name `repolense` is appended in `src/db/index.js`), `ACCESS_TOKEN_SECRET`/`ACCESS_TOKEN_EXPIRY`, `REFRESH_TOKEN_SECRET`/`REFRESH_TOKEN_EXPIRY`, `GROQ_API_KEY`, `GITHUB_TOKEN` (optional), `CORS_ORIGIN`.

## Architecture

Express 5 + Mongoose ESM API ("RepoLens") that ingests a GitHub repo, analyses it with an LLM, and supports RAG chat over it. Routes are mounted in `src/app.js` under `/api/v1/{users,repository,aiChat,health}`; the layering is routes → controllers → services, with `asyncHandler`, `ApiError`, `ApiResponse` in `src/utils` and a final `errorHandler` middleware. Auth is JWT (`verifyJWT`) with access/refresh tokens.

### Repo ingestion pipeline (`controllers/repo.controller.js` → `analyseRepo`)
1. Fetch metadata via Octokit, upsert a `Repo` scoped per user (unique index on `url + user`), and add it to `User.repoHistory`.
2. Respond `201` immediately, then run background work that is not awaited by the request:
   `extractFileStructureInternal` → then in parallel `analyzeRepoWithAIInternal` and `generateEmbeddingsForRepo`.
3. Progress is tracked on the Repo document via three independent status fields (`fileStructureStatus`, `aiStatus`, `embeddingStatus`: pending/processing/ready/failed). The client polls `GET /repository/getRepoInfo/:repoId?info=basicAnalysis|fileStructure|aiAnalysis`. Background failures are only logged and/or set the status; they never reach the HTTP response.

### AI / RAG
- LLM calls use Groq (`llama-3.3-70b-versatile`). Model output for analysis is parsed leniently (`jsonrepair` + sanitising in `services/aiAnalysis.service.js`).
- Embeddings are computed locally with `@xenova/transformers` (`Xenova/all-MiniLM-L6-v2`, lazily loaded singleton) in `services/embed.service.js`. Files are filtered by `constants.js` (`IGNORED_PATHS`, `IMPORTANT_ROOT_FILES`, `textExtensions`) and chunked at 1024 chars with 30% overlap; vectors are stored in the `Embedding` collection.
- Chat (`services/chat.service.js`): classifies the message intent (GREETING / ACKNOWLEDGEMENT / QUERY) with the LLM, answering the first two statically. For QUERY it embeds the question and brute-force cosine-scores every `Embedding` for the repo in memory (no vector DB), then sends the top 5 chunks to the LLM. Chat history is persisted via `Chat`/`Query` models.

## Gotchas
- CORS check in `src/app.js` is effectively always permissive: the `allowed` expression ends with a truthy string (`"http://localhost:3000"`), and `allowedOrigins` is unused. Fix this properly if touching CORS.
- `express.json` body limit is 16kb.
