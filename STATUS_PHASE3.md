# Status Handling Phase 3: What Changed

Branch: `feat/phase-3-status-handling`

| Area | Before | After |
|---|---|---|
| **File extraction fails** | The extraction function caught its own error and never rejected, so AI analysis and embedding still ran. AI failed with "No files for analysis", and embedding stored only the repo-metadata vector and marked `embeddingStatus` as `ready` with no file content. | `extractFileStructureInternal` returns `true` or `false`. If it returns `false`, the AI and embedding stages are not run and both are marked `failed` with the reason "Skipped because the repository files could not be read." The flow lives in `services/analysisPipeline.service.js`. |
| **Pipeline dies unexpectedly** | A stage could stay `processing` forever. | The pipeline has a last-resort handler that fails any stage still `processing` for that repo. |
| **Stuck `processing` repos** | After a restart or crash, repos stayed `processing` permanently. | On server start, any stage that has been `processing` with no update for 2 minutes is marked `failed`. The same sweep runs every 5 minutes with a 15-minute window. Message: "Analysis was interrupted. Please analyse the repository again." Re-submitting the repo starts a new run. |
| **Failure reasons** | Only a status; the user never learned why. | `statusErrors` on the repo holds a short user-facing reason per stage. Known GitHub errors (rate limit, 404, 401) are mapped to plain messages; everything else gets a generic text, so raw errors (which can contain IPs) are not exposed. |
| **Progress** | None. | `progress.fileStructure` and `progress.embedding` store `{done, total}` while running, updated every 10 files and every 25 files or 100 chunks. Each write also refreshes `updatedAt`, which keeps healthy runs from being swept. |
| **`getRepoInfo` response** | Only `statuses`. | `basicAnalysis` and the default response also include `progress` (`percent` plus the two counters) and `statusErrors`. `statuses` is unchanged, so the current frontend keeps working. |
| **"Already in progress" window** | 30 minutes, hard-coded in the controller. | Uses the shared `STALE_PROCESSING_MS` (15 minutes), the same value the sweep uses. |

## Overall percent

Weighted average: file structure 30%, AI analysis 20%, embedding 50%. A stage that is `ready` or `failed` counts as complete. The AI stage is one LLM call, so it counts as 0 until it finishes. A repo that has not started reports 0.

## Files

- New: `src/services/analysisPipeline.service.js`, `src/services/repoStatus.service.js`
- Changed: `src/services/{fileStructure,embed,getBasicAIAnlaysis}.js`, `src/controllers/repo.controller.js`, `src/models/repo.model.js`, `src/constants.js`, `src/index.js`

## Verification

Run against a real in-memory MongoDB, 15 checks, all passing:

- Indexes from Phase 2 are created in Mongo.
- Pipeline with a failing extraction (GitHub refused the request): all three stages end `failed`, no embeddings are created, and the user sees "GitHub rate limit reached. Please try again later."
- Embedding stage on 30 stored files: status `ready`, progress `31/31`, `.env` not embedded, and a second run replaces the vectors instead of duplicating them.
- Sweep: a repo with stale `processing` stages is failed on both stages, a repo with a fresh `processing` status is left alone. This caught a bug in the first version of the sweep (updating one stage refreshed `updatedAt` and hid the next), now fixed.
- Percent calculation for pending, ready and half-embedded cases.

Not tested: the AI stage (needs a Groq key), the successful file download path in this run (GitHub's unauthenticated quota was used up; it was tested in Phase 2), and the HTTP "already in progress" response.

## Notes

- Existing repos in Mongo that are stuck on `processing` are failed by the startup sweep the first time the server starts with this change.
- The sweep assumes one running server instance, or at most a brief overlap during a deploy. With several instances running at once, a long gap without progress writes (for example one very slow LLM call over 15 minutes) could be marked failed by another instance.
- The frontend can start showing `progress.percent` and `statusErrors` whenever you work on it. No frontend change is required for this to work.
