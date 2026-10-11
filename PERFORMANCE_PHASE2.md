# Performance Phase 2: What Changed

Branch: `perf/phase-2-ingestion-speed`

| Area | Before | After |
|---|---|---|
| **Fetching the file tree** (B4) | One GitHub call per directory (`getContent`, recursive). | One call for the whole tree (`git.getTree`, recursive) on the default branch. Same tree shape for the frontend (directory nodes still use the full path as `name`). |
| **Downloading file contents** (B4) | One call per file, one at a time. Every file was downloaded, including images, lockfiles and binaries. One failed file failed the whole repo. | Only text/code files that pass the filters are downloaded: no ignored folders, no credential files, at most 200 KB each, at most 1500 files (shallowest first). 8 downloads run at once. A file that fails is skipped. Blobs are fetched by SHA (`git.getBlob`), which has no 1 MB limit. |
| **Saving files** | `File.create` once per file. | `File.insertMany` in batches of 200. Only files with content are stored; the full tree still lives on the repo document. |
| **Saving embeddings** (B2) | `Embedding.create` once per chunk, so one database round trip per chunk. | Chunks are buffered and written with `Embedding.insertMany` in batches of 100. |
| **Re-analysing a repo** (B5) | Old `File`, `Embedding` and `Analysis` documents were never deleted, so each run added another copy and chat searched stale duplicates. | Old documents for the repo are deleted before the new ones are written. |
| **Concurrent runs** | Submitting the same repo again while it was running started a second pipeline on top of the first. | If a status is `processing` and was updated in the last 30 minutes, the API returns `200` with the existing repo and message "already in progress". The frontend then opens the chat as it does for a new repo. After 30 minutes a `processing` status is treated as stuck and a new run is allowed. |
| **Indexes** (B8) | None on `Embedding.repo`, `File.repo`, `Chat.repo`, `Analysis.repo`. | Indexes on `Embedding {repo}`, `File {repo, path}`, `Chat {repo}`, `Analysis {repo}`. Mongoose builds them at startup. |
| **Chat intent check** (D1) | An LLM call on every message to detect greetings and thanks. | A local regex check. Only pure greetings and thank-yous get the canned reply; everything else goes to the normal flow. Saves one Groq call per message. |
| **Chat retrieval** | Loaded full embedding documents into memory. | Loads only the four fields needed, as plain objects (`.lean()`). |
| **Embedding model** | Loaded separately in `embed.service` and `chat.service`. | One shared loader in `services/embeddingModel.js`. |

## Decision: no model-call batching

The review suggested batching several chunks per embedding-model call. I measured it before building it:

- 32 chunks one by one: about 2079 ms. The same 32 in one batch: about 2331 ms. There is no speedup on CPU.
- Batched vectors differ slightly from single ones (cosine similarity 0.983 to 0.998 depending on padding). Chat embeds one question at a time, so stored vectors would no longer match how queries are embedded.

So chunks are still embedded one at a time. The saving comes from fewer database round trips, not from the model.

## Files

- New: `src/services/embeddingModel.js`, `src/utils/fileFilters.js`
- Rewritten: `src/services/fileStructure.service.js`, `src/services/embed.service.js`
- Changed: `src/services/chat.service.js`, `src/services/getBasicAIAnlaysis.js`, `src/controllers/repo.controller.js`, `src/models/{embedding,file,chat,analysis}.model.js`

## Notes

- Indexes are created automatically on the next server start. On a large `Embedding` collection the first build can take a moment.
- Data already in Mongo is not cleaned up until that repo is analysed again.
- Files over 200 KB, and files beyond the first 1500, are no longer stored or embedded. Raise `MAX_FILE_BYTES` / `MAX_FILES_TO_FETCH` in `src/utils/fileFilters.js` if that is too strict.
- GitHub still counts one API call per downloaded file, so a `GITHUB_TOKEN` is needed for anything beyond tiny repos (60 calls per hour without one).
- Not done in this phase: Atlas Vector Search (B1), moving embedding to a worker or queue (B3, C1), sharing snapshots across users (B6).

## Verification

- Lint passes.
- Live run of the new file fetching against `prathmesh0/repolense-backend` on GitHub (Mongo calls stubbed): the whole tree came from one call, 42 text files were downloaded and stored in about 3.5 seconds, the 45-file tree was returned, the final status was `ready`, and old files were cleared once before writing.
- Embedding flow with stubbed models: 13 chunks from 5 sample files were written in a single `insertMany`, and the `.env` file and `node_modules` file were skipped.
- Intent check tested on greetings, thank-yous, and mixed messages such as "hi, what does auth do?" (those go to the normal flow).
- Not tested against a real database: index creation, `insertMany` against Mongo, and the "already in progress" response.
