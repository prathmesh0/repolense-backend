# Phase 8: Read-only `getRepoInfo` and Cookie-Ready Auth

Branch: `feat/phase-8-contract-and-cookies` (not committed yet)

## 1. `getRepoInfo` no longer writes to the chat (A6 + F1/F2)

| Area | Before | After |
|---|---|---|
| **Side effect** | Every `GET getRepoInfo` stored two chat messages: a label ("AI Analysis") and a JSON dump of the response. Polling filled the chat with dumps and the frontend rebuilt its cards from them. | `getRepoInfo` is read-only. Response bodies are unchanged. |
| **Old data** | n/a | Old chats still contain those messages. `npm run purge:fake-chat` lists them (dry run); `-- --apply` deletes them and rebuilds each chat's last-message summary. Real questions and answers are kept. |

**Release order matters.** Deploy the frontend that builds its cards from `getRepoInfo` first, then this backend. If this backend goes live while the old frontend is still in use, the old frontend finds no cards in the chat history. Run the purge only after both are live. Chats still in the pre-Phase-7 format should be migrated first (`npm run migrate:chat -- --apply`); the purge does not look inside them.

## 2. Cookie settings for cookie-only auth (G1)

| Area | Before | After |
|---|---|---|
| **Cookie attributes** | `httpOnly` + `secure`, no lifetime, no explicit `SameSite`, defined three times. | One place, `src/utils/authCookies.js`: `httpOnly`, `secure`, `SameSite=Lax`, `Path=/`, and `Max-Age` equal to the token expiry (`ACCESS_TOKEN_EXPIRY`, `REFRESH_TOKEN_EXPIRY`). |
| **Login lifetime** | Session cookies, so closing the browser logged the user out of the cookie (the frontend kept tokens in `localStorage` to compensate). | Cookies last as long as the tokens. |
| **Logout** | Cleared with different attributes than they were set with. | Cleared with matching attributes. |
| **Token source** | Cookie first, then the `Authorization` header. A stale cookie beat a fresh header. | Header first, then cookie. Safe while clients move over. |
| **Response bodies** | Tokens in the body. | Unchanged, for older clients. They can be dropped after the frontend stops using them. |

Config (optional): `COOKIE_SAMESITE` = `lax` (default) | `strict` | `none`, and `COOKIE_SECURE=false` for Safari on http://localhost.

### What the frontend must do for this to work

`SameSite=Lax` cookies are only sent when the browser talks to the API **through the frontend's own domain**. The Vercel app and the Render API are different sites, so:

- Route API calls through the Next.js rewrite (`/api/*` to the Render API) and call a relative path such as `/api/v1/...`. Cookies are then set on the Vercel domain and are first-party.
- No CORS is involved for those calls. `CORS_ORIGIN` can stay as it is.
- Stop storing tokens in `localStorage` and stop sending `Authorization`.
- Use `GET /users/me` for login state, and `credentials: "include"` is not needed for same-origin calls.
- `SameSite=None` (`COOKIE_SAMESITE=none`) would allow direct cross-site calls, but browsers increasingly block third-party cookies, so it is not recommended.

Why `Lax` is safe against CSRF here: browsers do not send Lax cookies on cross-site POST requests, and the API only accepts JSON bodies on its state-changing routes.

## Files

- New: `src/utils/authCookies.js`, `scripts/purge-fake-chat-messages.js`
- Changed: `src/controllers/repo.controller.js`, `src/controllers/user.controller.js`, `src/middlewares/auth.middleware.js`, `src/services/chatHistory.service.js` (`isFakeMessage`, `purgeFakeMessages`), `package.json`, `CLAUDE.md`
- Tests: `tests/integration/authCookies.test.js` (13), `tests/integration/chatHistory.test.js` (`getRepoInfo` writes nothing, purge)

## Verification

- 124 tests pass (15 new or changed). Lint passes.
- Broke on purpose and saw tests fail: cookie-before-header order, and missing cookie lifetime. Restored each.

## Not verified

- That Vercel's rewrite passes `Set-Cookie` through to the browser and that the cookie lands on the Vercel domain. This is documented Vercel behaviour but needs one real test on the deployed frontend.
- Safari behaviour with `Secure` cookies on http://localhost (use `COOKIE_SECURE=false`).
