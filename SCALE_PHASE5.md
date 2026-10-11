# Scale Phase 5: Vector Search and Job Queue

Branch: `feat/phase-5-vector-search-and-queue` (not committed yet)

## 1. Job queue (replaces fire-and-forget analysis)

| Area | Before | After |
|---|---|---|
| **Where analysis ran** | Started inside the request handler with no tracking. A restart or crash lost the work and left the repo stuck. | The controller adds a `Job` to MongoDB and returns `201`. A worker picks it up. Queued work survives restarts. |
| **Infrastructure** | n/a | None new: the queue lives in your existing MongoDB (no Redis). |
| **Duplicate runs** | A time-based guess ("processing and updated in the last 15 minutes"). | The database enforces one live job per repo (partial unique index on `repo` where `active: true`). A second submit returns the existing repo with `200`. |
| **Concurrency** | Unlimited: every submit started its own CPU-heavy embedding run. | `JOB_CONCURRENCY` (default 1) runs at a time. Others wait in line. |
| **Claiming** | n/a | Atomic `findOneAndUpdate` by oldest first, so several servers or workers never run the same job. |
| **Crash recovery** | The status sweeper only marked stages failed after a delay. | A running job refreshes a lease every 30 seconds. After 2 minutes without it, the job is retried (up to 2 attempts) and then failed together with the repo's stages. Recovery runs at startup and every minute. |
| **Shutdown** | Work killed mid-way. | On SIGTERM/SIGINT the worker stops taking jobs and waits up to 25 seconds for running ones; anything unfinished is recovered by the lease logic. |
| **Separate worker** | Not possible. | `RUN_WORKER=false` on the web server plus `npm run worker` on another machine or service keeps embedding off the process that answers requests. By default the web server runs the worker itself, so nothing changes if you do nothing. |
| **Status sweeper** | Failed any stale `processing` stage. | Skips repos that still have a live job; only fails truly orphaned ones. |
| **API** | n/a | `getRepoInfo` also returns `job: {status, position, attempts}` while a job is live (position is shown while waiting). Existing fields are unchanged. |

Finished jobs are deleted automatically after 7 days.

## 2. Vector search

| Area | Before | After |
|---|---|---|
| **Chat retrieval** | Loaded every embedding of the repo into Node memory and scored each one for every question. | `services/retrieval.service.js`: uses Atlas `$vectorSearch` filtered to the repo, so the database returns just the best 5. |
| **Fallback** | n/a | If Atlas or the index is unavailable (local database, index not created, error), or Atlas returns nothing yet (new vectors are indexed with a short delay), it falls back to a streaming scan that keeps only the best 5 instead of loading and sorting everything. After an Atlas error it does not retry for 5 minutes, so chat does not pay for a failing call each time. |
| **Config** | n/a | `VECTOR_SEARCH`: `auto` (default), `atlas` (same, logs failures as errors) or `memory` (never use Atlas). `VECTOR_INDEX_NAME`: defaults to `embedding_vector_index`. |
| **Index** | n/a | `npm run create:vector-index` creates it on Atlas (384 dimensions, cosine, filter on `repo`). The same definition can be pasted in the Atlas UI; see the script. |

## What you need to do on Atlas

1. Run `npm run create:vector-index` once against the production database (or create the index in the Atlas UI with the definition in `scripts/create-vector-index.js`). Atlas builds it in the background.
2. Until the index exists, chat keeps working through the fallback, with a single warning in the logs.
3. Optional: move analysis to its own service (`RUN_WORKER=false` on the web service, `npm run worker` as a background worker) if embedding slows the API.

## Files

- New: `src/models/job.model.js`, `src/services/jobQueue.service.js`, `src/services/retrieval.service.js`, `src/worker.js`, `scripts/create-vector-index.js`
- Changed: `src/index.js`, `src/controllers/repo.controller.js`, `src/services/chat.service.js`, `src/services/repoStatus.service.js`, `package.json`, `CLAUDE.md`
- Tests: `tests/integration/{jobQueue,retrieval,analyseApi}.test.js`

## Verification

- 87 tests pass (23 new). Lint passes.
- Queue: one live job per repo, restart after finish, queue position, a job given to exactly one of six concurrent claimers, oldest first, worker runs a job and resets the repo's run state first, concurrency limit holds, crash in the pipeline fails the job and stages, stale job re-queued, fresh heartbeat left alone, last attempt fails job and repo, sweeper skips repos with a live job, graceful shutdown waits for a running job and gives up after the timeout.
- Retrieval: ranking, repo isolation and `k` limit on the real fallback path; the Atlas pipeline shape (index, path, filter by repo `ObjectId`, limit, candidates) through a mocked `aggregate`; fallback on empty results; fallback on error and no retry afterward.
- HTTP: analyse queues one job and answers `201`, a second submit answers `200 "already in progress"` without a second job, a new job is allowed after the first finishes, bad URL `400`, no login `401`, queue state visible in `getRepoInfo`. This also covers the "already in progress" response that had not been tested before.
- I broke the retrieval filter, the job ordering and the duplicate guard on purpose; the tests failed for each, and I restored the code.
- Booted the real code against an in-memory database: web server with worker (health `200`), web server with `RUN_WORKER=false` (no worker), and `npm run worker` (worker running).

## Not verified

- **`$vectorSearch` against a real Atlas cluster.** The query and index definition follow Atlas's documented format, but I have no Atlas access here. Test it on your cluster after creating the index: ask a chat question and check the logs for the fallback warning.
- Real multi-instance behaviour (two servers sharing one database). The atomic claim is tested with concurrent claimers in one process.
- SIGTERM handling on a real host (the shutdown logic is tested by calling the stop function).

## Notes

- Existing repos with no job behind a `processing` status are failed by the sweeper after the normal delay, as before.
- Retries only cover a worker dying mid-run. A deterministic failure (repo not found, GitHub rate limit) is recorded on the stages and not retried.
- Still open for later phases: shared snapshots across users, chat memory and streaming, SSE for progress, and the contract and cookie changes that need the frontend.

## Deploying on Render (auto-deploy from `main`)

Nothing new is required, because every new setting has a default. Check these once:

| Item | What to do |
|---|---|
| **Start command** | `npm start` now runs `node src/index.js` (it used to point at a file that does not exist). If your service uses a custom start command such as `node src/index.js`, leave it. |
| **Build command** | Recommended: `npm ci --omit=dev`. It skips test tools. `mongodb-memory-server` (dev only) downloads a MongoDB binary when installed, which slows the build for no reason. Plain `npm install` also works but is slower. |
| **`NODE_ENV`** | Set `NODE_ENV=production` for JSON logs. If it is unset the app still starts (the logger now falls back to JSON when `pino-pretty` is not installed). |
| **Env vars to keep** | `MONGODB_URI`, `ACCESS_TOKEN_SECRET`/`ACCESS_TOKEN_EXPIRY`, `REFRESH_TOKEN_SECRET`/`REFRESH_TOKEN_EXPIRY`, `GROQ_API_KEY`, `GITHUB_TOKEN`, `CORS_ORIGIN` (must be your frontend URL exactly). |
| **New, all optional** | `JOB_CONCURRENCY` (default 1; keep 1 on a small instance, since embedding uses a lot of memory), `RUN_WORKER` (default true), `VECTOR_SEARCH` (default auto), `VECTOR_INDEX_NAME`, `LLM_MODEL`, `LOG_LEVEL`. |
| **Health check path** | `/api/v1/health/healthcheck` returns `200` when the database is reachable and `503` when it is not. It is safe to set as the Render health check path. |
| **Atlas vector index** | Create it once from your own computer, not from Render: set `MONGODB_URI` to the production value for that command and run `npm run create:vector-index`, or create it in the Atlas UI. Search indexes may be limited by your cluster tier. Chat works without it, through the fallback. |

Things to expect on the first deploy:

- Deploy when nobody is analysing a repo. A restart kills a run in progress, and runs that started before this release have no job record, so they are marked `failed` about 2 minutes after startup and the user has to analyse again.
- Mongo indexes (including the new job queue ones) are created automatically on startup.
- On Render's free plan the service sleeps when idle, and the worker runs inside it. A queued job waits until the next request wakes the service, and a job running when it sleeps is retried after wake-up. An always-on instance avoids this.
- During a deploy the old and new instances overlap for a short time. That is safe: jobs are claimed atomically, so a job runs on only one of them.
