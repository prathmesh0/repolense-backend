# Phase 9: demo mode (guest sessions)

Backend half of the "Try live demo" feature (plan items B1 to B8). A visitor gets a temporary real user, so the existing pages, SSE status stream and streaming chat work unchanged. All limits are enforced here, never trusted from the client.

## API contract

| Endpoint | Change |
|---|---|
| `POST /users/demo-login` | New. Body optional (`captchaToken` only if `TURNSTILE_SECRET` is set). Returns `{user, accessToken}`. Sets an `accessToken` **browser-session cookie** (no `Max-Age`), no refresh token. |
| `GET /users/me` | Adds `isDemo`. Guests also get `demo: {analysesUsed, analysesMax, chatUsed, chatMax, expiresAt}` and no `email`. |
| `POST /users/logout` | For a guest: deletes the guest and all its data immediately ("End demo"). |
| `GET /repository/samples` | New. `[{repoId, name, owner, description, language, stars}]`, only fully analysed samples. |
| `POST /repository/analyse` | Guests: 2 analyses. `403 DEMO_LIMIT_REACHED` after that. |
| `getRepoInfo`, `status-stream`, `chat`, `chat-history` | Also accept a sample repo id (shared, read-only). |

Error shape stays `{success, message, errors, data}`; demo errors put a code in `errors`, e.g. `"errors": [{"code": "DEMO_LIMIT_REACHED"}]`.

| Code | Status | When |
|---|---|---|
| `DEMO_DISABLED` | 503 | `DEMO_ENABLED=false` |
| `DEMO_RATE_LIMITED` | 429 | per-IP limits on `demo-login` and on started analyses |
| `DEMO_LIMIT_REACHED` | 403 | 3rd own analysis |
| `DEMO_CHAT_LIMIT_REACHED` | 429 | more than `DEMO_CHAT_MAX` messages |
| `DEMO_REPO_NOT_ALLOWED` | 400 | private repo |
| `DEMO_REPO_TOO_LARGE` | 400 | GitHub size over `DEMO_MAX_REPO_KB` |
| `DEMO_CAPTCHA_FAILED` | 400 | captcha enabled and token missing or invalid |

Quota rules: re-submitting a URL the guest already analysed returns `200` (no GitHub call, no re-run, no charge). A `200` "already in progress", any `4xx` before the job starts, and a failure while starting the job do not consume a slot. A job that fails later still counts. A chat message that fails before an answer is given back.

## Decisions (agreed with the owner)

Session 60 min, chat cap 20, branch from `main`, 3 sample repos (`sindresorhus/is`, `tj/commander.js`, `expressjs/cors`, overridable with `SAMPLE_REPOS`), captcha as an off-by-default hook, "End demo" deletes immediately.

## Differences from the plan

- **No TTL indexes.** A TTL on `User` removes only the user and leaves its repos, embeddings, files and chats behind (and TTL on children needs the field on every document). Instead `sweepExpiredDemo` runs every `DEMO_CLEANUP_MINUTES` (default 10) from `index.js` and cascades by user id, plus an orphan pass for repos whose guest is already gone. Expired guests get `401` from `verifyJWT` immediately, before the sweep.
- **Chat per guest on samples** needed a `user` field on `Chat` and `ChatMessage` (set only for sample chats; a user's own repo chats are unchanged).
- **Repo size guard** uses GitHub's `size` (KB). A file-count cap was not added; the pipeline's existing limit of 1500 files still applies.
- **Lower `max_tokens` for demo chat** was not done (optional in the plan).
- **Priority instead of a separate concurrency cap:** demo jobs have `priority: 1`, so real users' jobs are always claimed first.
- The `analyseRepo` GitHub fetch and repo upsert moved to `services/repoIngest.service.js` (same behaviour) so `npm run seed:samples` reuses it.

## Deploy order

1. Merge and deploy this branch. Set `GITHUB_TOKEN` (rate limits), keep `COOKIE_SECURE`/`COOKIE_SAMESITE` as today (Lax works through the frontend `/api` proxy). No migration is needed: all new fields have defaults and new indexes build on start.
2. Run `npm run seed:samples` once against production (needs `MONGODB_URI`, `GITHUB_TOKEN`, `GROQ_API_KEY`). Check `GET /repository/samples` returns 3 entries.
3. Only then merge the frontend demo button.

Kill switch: `DEMO_ENABLED=false`.

## Tests

`tests/integration/demo.test.js` and `demoRateLimit.test.js` (27 tests): login and cookie, kill switch, captcha hook, expiry, quota (limit, refunds, double submit, private/oversize), IP caps, priority, chat cap, sample access and per-guest chat isolation, logout deletion, sweep and orphans. Run with `npm test`; GitHub and the LLM are mocked.
