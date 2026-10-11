# RepoLens — Review & Improvement Plan (Backend + Frontend)

Backend: `repolense-backend` (read locally). Frontend: https://github.com/prathmesh0/repolens-frontend.

**Contents:** Backend sections A–E, then the Frontend section (F–J), then a combined rollout order at the end.

## What the project does today

1. User registers or logs in (JWT in cookies).
2. User submits a GitHub URL. The API pulls metadata with Octokit and saves a per-user `Repo`.
3. It returns `201` immediately. In the background it fetches the whole file tree and every file's content into the `File` collection.
4. Two jobs then run in parallel:
   - LLM analysis: summary, architecture, complexity, potential issues.
   - Chunking files and embedding them locally (MiniLM), with vectors stored in Mongo.
5. Chat classifies intent. For a real question it embeds the question, scores every vector in memory, sends the top 5 chunks to Llama 3.3 on Groq, and saves the history.

---

## A. Security and correctness (fix first)

| # | Flaw | Fix |
|---|---|---|
| 1 | **No ownership checks.** `GET /repository/getRepoInfo/:repoId` has no `verifyJWT`. Chat routes check login but never that the repo belongs to the user. Anyone with a repo ID can read another user's data and chat history. | Add `verifyJWT` to `getRepoInfo`. Use `Repo.findOne({_id, user: req.user._id})` everywhere. Make `Chat` per user and repo (`{repo, user}`); today it is one chat per repo. |
| 2 | **CORS is always open.** In `app.js` the `allowed` expression ends in a truthy string, and `allowedOrigins` is unused. With `credentials: true`, any origin is accepted. | Use `allowedOrigins.includes(origin) \|\| origin.endsWith(".vercel.app")`. Ideally pin the exact Vercel URL, since `.vercel.app` matches anyone's site. |
| 3 | **`.env` is in `IMPORTANT_ROOT_FILES`.** A repo's `.env` is stored in Mongo, embedded, and sent to Groq. | Remove `.env` from the list. Add secret-file patterns (`.env*`, `*.pem`, `id_rsa`) to the ignore list. Scan chunks for key patterns before storing or embedding. |
| 4 | **Prompt injection.** Repo content and the user's question go straight into the prompts. A malicious repo can embed "ignore previous instructions". | Put instructions in a `system` message and the repo content in a delimited, labelled block. Tell the model to treat it as untrusted data. |
| 5 | **No rate limiting.** Each chat message makes 2 Groq calls and loads all of a repo's vectors. Registration and analysis are also open to abuse. | Add `express-rate-limit` per user and IP, with tighter limits on `/analyse` and `/chat`. |
| 6 | **`getRepoInfo` writes to the chat on every GET.** It pushes a fake "user" message and a JSON dump into `Chat`. Polling for status fills the chat with junk. | Remove it. Make `getRepoInfo` read-only. |
| 7 | **Creating a chat on a GET** (`chat-history`), no `repoId` validation, no `question` length cap. | Validate ObjectIds and question length (zod or joi). Return an empty array without creating a document. |
| 8 | **Weak error handling.** `analyseRepo` catches everything and returns 500, hiding `ApiError` codes (404, 400, 401). | Remove the try/catch and let `asyncHandler` and `errorHandler` do their job. |

---

## B. Performance and scalability

| # | Flaw | Fix |
|---|---|---|
| 1 | **Vector search is brute force.** Each chat loads all `Embedding` docs (384 floats plus chunk text) into Node memory and loops over them. | Use **MongoDB Atlas Vector Search** (`$vectorSearch`) with a vector index filtered by `repo`. Alternatives: pgvector, Qdrant. Minimum: `.select("path chunkIndex contentPreview vector").lean()` and a min-heap for top-k. |
| 2 | **Embedding is sequential.** One chunk, one `Embedding.create`, one DB round trip at a time. `chunkArray` exists in utils but is unused. | Batch model calls (e.g. 32 chunks per call) and `Embedding.insertMany` in batches of a few hundred. Likely 5–10× faster. |
| 3 | **Embedding runs on the web server**, using the CPU for the whole job. The model is also loaded twice (`embed.service` and `chat.service`). | Share one model-loader module. Move embedding to a worker thread or queue consumer (see C1), or use a hosted embedding API. |
| 4 | **File fetching is slow.** One API call per directory, then one per file, serially. It also fetches `node_modules`, images and lockfiles. One failed file aborts the whole repo. | Use **one call** to `git.getTree({recursive: true})`. Filter with `IGNORED_PATHS` and size limits **before** fetching content. Fetch blobs with a small concurrent pool (`p-limit`, 5–10). Skip failed files instead of aborting. Or download the tarball once. Note `IGNORED_PATHS` is currently applied only at embed time, so ignored files are still downloaded and stored. |
| 5 | **Re-analysing a repo duplicates data.** `File` and `Embedding` docs are never deleted, so each re-run adds a full copy and chat searches stale duplicates. | Delete old `File`/`Embedding`/`Analysis` for the repo before re-running. Better: store the commit SHA and re-embed only files whose blob SHA changed. |
| 6 | **Duplicate work across users.** The index is per user, so ten users analysing the same repo means ten full downloads and embeddings. | Cache by `(owner, name, commitSha)`. Share a global snapshot and embeddings, with a per-user pointer. Biggest cost saving. |
| 7 | **Chat history is a growing array in one document.** 16MB document limit; the whole array loads on every message; no pagination. | One document per message (`Message` collection, indexed by `chat, createdAt`) and paginate. |
| 8 | **Missing indexes** on `Embedding.repo`, `File.repo`, `Chat.repo`, `Analysis.repo`. | Add `index: true` or compound indexes. `Embedding` matters most. |
| 9 | **No caching** on `getRepoInfo` or GitHub metadata calls. | Use ETag / If-None-Match for GitHub calls, plus short-lived caching. |
| 10 | **Analysis sees only 8000 chars** of "important files", so a big repo's summary rests on the README and `package.json`. Chunks are 1024 characters with no regard for code structure. | Map-reduce summary (per directory, then combine). Chunk by function/class (tree-sitter) or at least by lines. Make top-k tunable (8–10 after re-ranking). |

---

## C. Reliability and architecture

1. **Background work is fire-and-forget inside the web process.** A deploy, crash or restart leaves a repo stuck on `processing` forever. Use a job queue (BullMQ + Redis, or Agenda on Mongo) with retries, concurrency limits and resume. At minimum, add a startup sweep that marks stale `processing` repos as `failed`, plus a `/retry` endpoint.
2. **Polling for status.** The client polls `getRepoInfo`. Use **SSE** for progress, with percent complete (files embedded / total).
3. **No timeouts or retries on Groq or GitHub calls.** Add backoff on 429s and handle GitHub rate limits via response headers. `GITHUB_TOKEN` is shared, so heavy use hits its limit. Consider GitHub OAuth so each user uses their own quota (also enables private repos).
4. **Model name hardcoded in four places.** The log says "llama-4-maverick" while the code uses `llama-3.3-70b-versatile`. Move it to config, and use a smaller, cheaper model for intent classification.
5. **Logging.** `console.log` dumps full AI responses and chat context. Use `pino` with levels and don't log repo content.
6. **Unused or inconsistent code.** The `Query` model, `chunkArray`, `allowedOrigins`, and the "repolense" vs "Repolens" naming.
7. **No tests, CI or deep health check.** Add vitest + supertest for parsing, chunking and similarity utilities. The health check should also ping Mongo.

---

## D. Quality of AI answers

1. **Intent classification costs an extra LLM call per message.** Use a regex/keyword check for greetings and thanks, and call the model only if unsure. Saves roughly 300–800 ms and tokens per message.
2. **No conversation memory.** History is stored but never sent to the model, so follow-ups like "explain that file more" fail. Send the last N messages and rewrite the question into a standalone query before retrieval.
3. **No streaming.** Use Groq's `stream: true` and relay it over SSE. Perceived latency drops a lot.
4. **Retrieval quality:**
   - Hybrid search: BM25 or `fuse.js` (already a dependency, unused) combined with vectors.
   - Filter out low-score results so unrelated questions answer "not found in this repo" rather than guessing.
   - Include file path headers in the embedded text.
   - Embed the file tree and AI summary as retrievable context too. Today only `REPO_METADATA` is embedded, and nothing guarantees it gets retrieved.
5. **Citations are file names only.** Return `path`, line range and score so the frontend can link to GitHub (`/blob/<sha>/path#L10-L30`).
6. **Structured output.** Use JSON mode or tool calling instead of the `jsonrepair` workaround.

---

## E. Missing features (easiest first)

| Feature | How to add it |
|---|---|
| **Private repos** | GitHub OAuth login, store the encrypted token, use it in Octokit. |
| **Re-sync / webhook** | Store `lastCommitSha`. Add a "Sync" button and an optional push webhook that triggers an incremental re-embed. |
| **Delete repo and data** | `DELETE /repository/:id` cascading to `File`, `Embedding`, `Chat`, `Analysis`. Also needed for privacy compliance. |
| **List and search repos** | `GET /repository` with pagination. |
| **Dependency graph / import map** | Parse imports (tree-sitter or regex) into a graph, so the visualization shows real relationships, not just the folder tree. |
| **Better code intelligence** | Detect language and framework, list entry points, API routes and env vars, add a "how to run" section. |
| **Security and quality scan** | Dependency vulnerabilities (OSV API on `package.json` and lockfiles), hardcoded secrets, large files. |
| **Commit and PR insights** | Hot files, bus factor, recent activity from the GitHub API (contributors and commit count are already collected). |
| **Multiple chats per repo, export** | Titled chat sessions and Markdown export. |
| **Usage limits and quotas** | Per-user caps on repos and messages, shown in the UI. |
| **Observability** | Job dashboard, metrics, error tracking (Sentry). |

---

## Suggested order

1. **Security (small edits):** A1, A2, A3, A6, A8, and rate limiting from A5.
2. **Speed and cost:** B2 (batching), B4 (git tree + filtered fetch), B5 (dedupe on re-run), B8 (indexes), D1 (skip intent LLM call), D3 (streaming).
3. **Scale:** B1 (Atlas Vector Search), C1 (queue), B6 (shared snapshots), D2 (memory).
4. **Features:** section E, starting with delete, re-sync and private repos.

**Note on the resume claim "cutting analysis time 80%":** to have a defensible number, time a before-and-after run on one fixed repo once the batching and git-tree changes are in.

---

# FRONTEND (`repolens-frontend`)

Repo: https://github.com/prathmesh0/repolens-frontend (Next.js 15 App Router, React 19, TanStack Query, Formik + Yup, Tailwind v4 + shadcn/Radix, framer-motion, `ogl` particles, `react-syntax-highlighter`, `next-themes`).

## What the frontend does today

- **Routes:** `/login`, `/register`; private `/home` (paste a GitHub URL) and `/chat/[repoId]`, with a sidebar of repo history and search.
- **Chat page:** loads chat history; if empty, fetches basic repo info. Quick actions ("Basic Analysis", "Get File Structure", "AI Analysis") call `getRepoInfo?info=...` and render cards or a collapsible `FileTree`. Free-text questions go to `/aiChat/chat/:repoId`, and the answer is rendered by a hand-written `AIResponseFormatter`.
- **Auth:** access and refresh tokens are kept in `localStorage` and sent as `Authorization: Bearer`. A custom `enhancedFetch` tries a refresh on 401.

## F. Critical: frontend and backend are coupled in a fragile way

| # | Flaw | Fix |
|---|---|---|
| F1 | **The chat page depends on the backend bug flagged in A6.** `getRepoInfo` writes a fake user message and a JSON dump of the response into the chat history. On reload, the frontend runs `parseJSONSafe(msg.content)` and, if it finds `basicInfo` / `fileStructure` / `aiAnalysis`, re-renders the cards. **If you fix A6 on the backend alone, restored chats lose their cards and show raw text.** | Fix both sides together. Give `Message` a `type` (`text`, `repo_info`, `file_tree`, `analysis`) and an optional `payload`. The backend saves one only when the user explicitly requests an action (a `POST`, not a GET). The frontend renders by `type` instead of sniffing JSON. |
| F2 | **The full response is duplicated in chat history.** The whole file-tree JSON is saved into the chat doc each time "Get File Structure" is clicked. On big repos this bloats the chat document (see B7) and the history request. | Store only a reference (`type` + `repoId`) and re-fetch the data when rendering. |
| F3 | **Inconsistent response shapes and status codes.** The frontend checks `res.success === false && res.data === null` and assumes "still running in the background", so a real error and the "No embeddings found" case look the same. | Use proper status codes and a stable error body (`{code, message}`). The frontend maps codes (`EMBEDDINGS_NOT_READY`, `UNAUTHORIZED`, `RATE_LIMITED`) to messages. |

## G. Frontend security and auth

| # | Flaw | Fix |
|---|---|---|
| G1 | **Tokens (access and refresh) in `localStorage`.** Any XSS can steal both. The backend already sets httpOnly cookies, but the frontend doesn't rely on them. | Use the httpOnly cookies only. Drop `token` / `refreshToken` from `localStorage` and the `Authorization` header. Since the API is on another domain, use the Next.js rewrite (`/api/*` is already configured in `next.config.ts` but unused) so cookies become first-party. This also avoids third-party-cookie blocking and CORS. |
| G2 | **Refresh-token bug.** `refreshAccessToken` reads `data.accessToken`, but the backend returns `{data: {accessToken, refreshToken}}`. The saved values are `undefined`, stored as the string `"undefined"`, and the next `JSON.parse` in `getFromLocalStorage` throws. It only seems to work today because the cookie is still sent. | Read `data.data.accessToken` (or go cookie-only, G1) and guard `JSON.parse`. |
| G3 | **Request-queue bug in `enhancedFetch`.** After the refresh, the request that triggered it is pushed into `pendingRequests` *after* the queue was already flushed, so **its promise never resolves** and the UI hangs on that call. | Use one shared `refreshPromise`. On 401, `await` it, then retry the original request once. On a second 401, redirect to login. |
| G4 | **Route protection does nothing.** `middleware.ts` protects `/dashboard` and `/profile`, which don't exist. `/home` and `/chat/*` are guarded only on the client, and the middleware looks for a cookie set on the API domain, not the frontend domain. | Change the matcher to `/home` and `/chat/:path*`, and redirect logged-in users away from `/login`. This works once cookies are first-party (G1). |
| G5 | **Flaky login state.** `AppContextProvider` hydrates from `localStorage` after mount, so protected pages can flash or redirect wrongly. Auth is stored twice (`auth` and `token`/`user`). | One source of truth: a `GET /users/me` query with the cookie. Gate the layout on it and show the skeleton while loading. (Needs a new backend endpoint.) |
| G6 | **Errors are swallowed.** `apiGet` / `apiPost` call `res.json()` without checking `res.ok`, and the service classes catch everything and `console.log`. A 500 HTML page throws a parse error. | One `request()` helper: check `res.ok`, parse safely, throw a typed `ApiError` with status and code. TanStack Query then gets real `error` states. |

## H. Performance and UX

| # | Flaw | Fix |
|---|---|---|
| H1 | **Manual polling via buttons.** While analysis runs, the user clicks "AI Analysis" repeatedly and sees "try again later". Chat fails with "No embeddings found" until embedding finishes. | Poll `basicAnalysis` for `statuses` with `refetchInterval` until all are `ready` or `failed` (or use SSE, backend C2). Show a 3-step progress bar (file structure, AI analysis, embeddings). Disable the chat input until `embeddingStatus === "ready"`. |
| H2 | **No streaming chat.** A loading bubble shows until the whole answer arrives. | Consume a streamed response and append tokens to the last message. Pairs with backend D3. |
| H3 | **`staleTime: 0` everywhere**, plus `enabled: false` + manual `refetch`. Every navigation refetches. | Set `staleTime` of 30–60 s. Use `useMutation` for sending a message, with cache updates, instead of local `useState` arrays. |
| H4 | **Chat state is an array of JSX elements.** JSX in state is hard to persist, test or virtualise. The "already added" check digs into `props.children[0].props.children`, which breaks with any markup change. Messages use `key={i}`. | Store plain data (`{id, role, type, content, payload}`) and map it to components at render time with stable ids. |
| H5 | **Hand-rolled markdown renderer** using regex. It can't handle lists, headings, links, tables or nesting. | Use `react-markdown` + `remark-gfm`, keeping `react-syntax-highlighter` for code. Add a copy button on code blocks. |
| H6 | **No virtualisation.** `FileTree` renders the whole tree (thousands of nodes on big repos) with framer-motion on every folder. `Particles` (WebGL, 200 particles) runs continuously on `/home`. | Virtualise the tree (`react-arborist` or `@tanstack/react-virtual`), render children only when expanded, `dynamic()`-import `Particles` and the syntax highlighter, pause particles when the tab is hidden, honour `prefers-reduced-motion`. |
| H7 | **Artificial 1 s delay on `/home`** (`setTimeout(..., 1000)` before reading `localStorage`). | Remove it and read the user from the auth query (G5). |
| H8 | **Sidebar search fires a request per keystroke.** | Debounce (300 ms) and use `placeholderData: keepPreviousData`. |
| H9 | **`isMobile` is hard-coded to `false`** in the private layout, so the mobile overlay never shows. | Derive it from the resize handler or a `useMediaQuery` hook, and close the sidebar on route change on mobile. |
| H10 | **Dead dependencies.** `reactflow` is installed but never imported, and the old `@shadcn/ui` placeholder package is likely unused. | Remove unused packages, then check the bundle with `@next/bundle-analyzer`. |

## I. Code quality and maintainability

1. **Typos in names:** `ENPOINTS`, `ChatPageSkelaton.tsx`, `HomePageSkelaton.tsx` (and `getBasicAIAnlaysis.js` on the backend). Rename while the project is small.
2. **Duplicate API layers.** `AppContextProvider` calls `apiPost('/users/login')` directly while `User.handleLogin` and `ENPOINTS.USERS.LOGIN` also exist. `ENPOINTS` prefixes `API_BASE` and `enhancedFetch` also prefixes `BASE_URL`, with different fallbacks (`''` vs `localhost:8000`). Keep the base URL in one place.
3. **Type-guard soup.** `isBasicRepoInfo`, `isFileStructureRepoInfo`, etc. exist because one endpoint returns different shapes. Return a discriminated union (`{kind: 'basic', ...}`) or split into separate endpoints.
4. **Oversized page component.** `chat/[repoId]/page.tsx` is about 400 lines of effects and handlers. Extract `useChat(repoId)` and `useRepoActions(repoId)` hooks.
5. **`useEffect`-based hydration** (history to messages, repo info to first message) can double-add messages. Derive messages from query data instead.
6. **No tests.** Add Vitest + Testing Library for helpers and hooks, and Playwright for login, analyse and chat smoke tests.
7. **Accessibility.** Chat bubbles have no `aria-live`; the file tree uses clickable `div`s (no keyboard support, no `role="tree"`); icon-only buttons need labels.
8. **Route-level states.** Add `error.tsx`, `loading.tsx` and `not-found.tsx` (for an invalid `repoId`).

## J. Missing frontend features (pair with backend section E)

| Feature | How to add it |
|---|---|
| **Real repo visualisation** | `reactflow` is already a dependency but unused. Build a module/dependency graph from backend import-map data, with click-to-open file details. Your description promises "interactive repository visualization", but today it is only a collapsible tree. |
| **File viewer with source citations** | Show answer sources as clickable chips that open a side panel with the file content and highlighted lines (or a GitHub link at the analysed commit). |
| **Analysis progress screen** | Step-by-step status (H1) instead of landing in an empty chat. |
| **Delete / re-sync repo buttons** | In the sidebar, calling the new backend endpoints. |
| **Multiple chats, rename, export to Markdown, copy / regenerate answer, thumbs up/down** | Needs backend chat sessions and a feedback field. |
| **Suggested questions** | After analysis, show 4–5 generated prompts ("How does auth work?") as chips. Cheap and improves first use. |
| **Private repo connect (GitHub OAuth)** | A "Connect GitHub" button once backend OAuth exists. |
| **Usage / quota indicator and 429 handling** | Show remaining messages and handle rate limits gracefully. |
| **Keyboard shortcuts** | `/` to focus the input, Ctrl+K to search repos. |

---

# COMBINED ROLLOUT ORDER (backend first, then frontend)

This order respects the coupling in F1.

**Phase 1 — Backend security (no frontend change needed)**
A1 (ownership), A2 (CORS), A3 (`.env`), A5 (rate limit), A7, A8.

**Phase 2 — Backend performance (no frontend change needed)**
B2 batching, B4 git-tree fetch, B5 dedupe, B8 indexes, D1 skip the intent LLM call.

**Phase 3 — Contract change (backend and frontend together)**
- A6 + F1/F2: typed chat messages and removing the GET side effect. **Ship both sides in the same release**, and migrate or ignore old JSON-dump messages.
- F3: proper status codes and an error shape.
- G1: cookie-only auth with the `/api` proxy rewrite (backend cookie `SameSite` and CORS must match).
- Add `GET /users/me`.

**Phase 4 — Frontend fixes**
G2, G3, G4, G5, G6, then H1, H3, H4, H7, H8, H9, H10.

**Phase 5 — Scale and AI quality**
B1 vector search, C1 queue + SSE, D2 memory, D3 + H2 streaming, H5 markdown, H6 tree virtualisation.

**Phase 6 — Features**
Delete, re-sync, citations viewer, reactflow graph, private repos, suggested questions, sessions and export.

### Quick wins (under an hour each)
- G3: fix the request that never resolves after a refresh.
- G2: read `data.data.accessToken`.
- H7, H9, H10: remove the fake delay, fix `isMobile`, drop unused packages.
- G4: fix the middleware matcher.
- B8: add DB indexes.
- A2: correct the CORS check.
