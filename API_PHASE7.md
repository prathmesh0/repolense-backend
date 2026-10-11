# Phase 7: Chat Collection, `/users/me`, Progress Stream

Branch: `feat/phase-7-chat-collection-me-sse` (not committed yet)

## 1. Chat messages in their own collection (B7)

| Area | Before | After |
|---|---|---|
| **Storage** | One `Chat` document per repo with a `messages` array. It grows with every message, and every `getRepoInfo` call added two more (a JSON dump of the response). A MongoDB document is capped at 16 MB. | `ChatMessage` documents (`repo`, `role`, `content`, `createdAt`), index `{repo, _id: -1}`. `Chat` keeps one document per repo with `lastMessage`, `lastMessageAt` and `messageCount`. |
| **Writes** | Load the document, push, save (or `$push` the whole array). | Insert message documents, then update the chat summary. |
| **History endpoint** | Returned every message. | Returns the newest 500 by default. `?limit=` (max 500) and `?before=<messageId>` page backwards. The response gains `hasMore`; existing fields are unchanged. |
| **Memory for the model** | Read the whole array. | Reads only the last 6 messages. |
| **Repo list (`/users/repo-history`)** | One query per repo, loading all messages just to show the last one. | One query for all summaries. `messagePreview.content` is cut at 500 characters. |

### Migration

- **Lazy:** the first time an old-format chat is read or written, it is moved automatically. Message ids and timestamps are kept. Nothing needs to be run before or right after deploying.
- **Bulk (optional):** `npm run migrate:chat` is a dry run that lists what would move. `npm run migrate:chat -- --apply` moves everything. It is safe to run again and while the app is running.
- Old repo-list previews work before a chat is migrated.

## 2. `GET /api/v1/users/me`

Returns `{_id, username, email, createdAt}` for the logged-in user (cookie or Bearer token), or `401`. No password or token fields. It is the single check the frontend can use for "am I logged in" once it stops reading `localStorage`.

## 3. Progress stream (C2)

`GET /api/v1/repository/status-stream/:repoId` (login and ownership required) answers with `text/event-stream`:

| Event | Data |
|---|---|
| `status` | `{statuses, progress, statusErrors, job, finished}`. The same fields `getRepoInfo` returns. Sent immediately, then only when something changed. |
| `done` | Sent once nothing is running or queued. The stream then closes. |
| `error` | `{message}`. |

- The server checks the database every 1.5 s per open stream, so it works across several server instances and does not depend on which one runs the job. `STATUS_STREAM_POLL_MS` changes the interval.
- A comment line is sent every 15 s to keep proxies from closing an idle connection.
- A stream is closed after 15 minutes (`done` with `reconnect: true`). At most 5 streams per user are open at once (`429` beyond that).
- `EventSource` works here because this is a GET and the cookie is sent. With a Bearer token, read the stream with `fetch` instead.
- `getRepoInfo` polling is unchanged and stays available.

## Files

- New: `src/models/chatMessage.model.js`, `src/services/chatHistory.service.js`, `src/controllers/status.controller.js`, `scripts/migrate-chat-messages.js`
- Changed: `src/models/chat.model.js`, `src/controllers/{chat,repo,user}.controller.js`, `src/routes/{repo,user}.routes.js`, `package.json`, `CLAUDE.md`
- Tests: `tests/integration/chatHistory.test.js` (12 new); `chatMemory.test.js` updated for the new storage

## Verification

- 109 tests pass (12 new). Lint passes.
- Broke on purpose and saw tests fail: the paging cursor, migration on read, and the ownership check on the stream. Restored each.
- Ran the migration script for real against an in-memory database: dry run changed nothing, `--apply` moved 2 messages and removed the array, a second `--apply` found nothing.

## Not verified

- The stream through Render's proxy (tokens and status events should arrive immediately). Check once after deploy.
- Migration on a production-size dataset.
- Several server instances each holding streams.

## Notes

- `getRepoInfo` still writes its two fake messages per call. Removing them is part of the frontend release (A6 + F1/F2); until then they now go into `ChatMessage`.
- `Chat.repo` is still a non-unique index. Two simultaneous first messages for a repo could create two `Chat` documents; reads use the oldest, and messages are keyed by repo, so none are lost.
