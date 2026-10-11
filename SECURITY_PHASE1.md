# Security Phase 1: What Changed

Branch: `security/phase-1-hardening`

| Area | Before | After |
|---|---|---|
| **Repo access** (`GET /repository/getRepoInfo/:repoId`) | No login required. Any repo ID returned that repo's data. | Requires login and ownership (`requireOwnedRepo`). A repo that isn't yours returns 404. |
| **Chat access** (`/aiChat/chat/:repoId`, `/chat-history/:repoId`) | Login required, but no check that the repo was yours. | Same ownership check. `repoId` must be a valid ObjectId. |
| **CORS** (`app.js`) | The check always passed because the expression ended in a truthy string, so every origin was allowed with credentials. `allowedOrigins` was unused. | Exact allow-list: `CORS_ORIGIN`, `https://repolens-frontend.vercel.app`, `http://localhost:3000`. Requests with no `Origin` header (curl, server-to-server) are still allowed. |
| **Secrets in repos** | `.env` was in the "important files" list, so its content was stored in Mongo, embedded, and sent to the LLM. | Credential files (`.env*`, `*.pem`, `id_rsa*`, `credentials.json` and similar) are kept in the tree but never downloaded, stored, embedded or sent to the LLM. `.env.example` is still allowed. Keys inside normal files (GitHub, AWS, Groq, OpenAI-style, Mongo URIs with passwords, private key blocks) are replaced with `[REDACTED]`. See `src/utils/secrets.js`. |
| **Rate limiting** | None. | Global 300 per 15 min. Login, register and token refresh 20 per 15 min. Analyse 10 per hour. Chat 15 per minute. Per user when logged in, otherwise per IP. Returns 429. `trust proxy` is enabled so the real IP is used. |
| **Input validation** | Chat question and login fields were not type-checked, so `{"$ne": ""}` could be sent as `email`. The chat-history GET created a chat as a side effect. | `question` must be a non-empty string of at most 2000 characters. Login and register require string fields. `url` in analyse must be a string of at most 300 characters. Chat-history GET is read-only and returns an empty list with `chatId: null` when none exists. |
| **Error handling** (`analyseRepo`) | A catch-all turned every error into a 500, hiding 400, 401 and 404. | Catch-all removed. `asyncHandler` and `errorHandler` return the real status code. |
| **Cookies** | Option typo `httpsOnly`, so cookies were not httpOnly. | `httpOnly: true` on login, logout and refresh. |

## Files

- New: `src/middlewares/ownership.middleware.js`, `src/middlewares/rateLimit.middleware.js`, `src/utils/secrets.js`
- Changed: `src/app.js`, `src/constants.js`, `src/routes/{repo,chat,user}.routes.js`, `src/controllers/{repo,chat,user}.controller.js`, `src/services/{embed,fileStructure}.service.js`, `src/utils/fileSelector.js`
- Dependency added: `express-rate-limit`

## Deployment notes

- If the production frontend is not exactly `https://repolens-frontend.vercel.app`, set `CORS_ORIGIN` to its URL. Vercel preview URLs are no longer allowed.
- Rate-limit numbers are starting values; tune them in `rateLimit.middleware.js`.
- `getRepoInfo` still writes into the chat history, because the frontend rebuilds its cards from those messages. Removing that must ship together with a frontend change.
- Files already stored in Mongo before this change may still contain credential content. Re-analysing does not remove them. A one-off cleanup deleting `File` documents with sensitive paths is needed.

## Not covered here

Prompt injection (A4) and the other phases in `IMPROVEMENTS.md`.
