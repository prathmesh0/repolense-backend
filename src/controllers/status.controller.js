import { Repo } from "../models/repo.model.js";
import { getQueueInfo } from "../services/jobQueue.service.js";
import { computeProgress, STAGES } from "../services/repoStatus.service.js";
import { ApiError } from "../utils/apiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { logger } from "../utils/logger.js";

const pollMs = () => Number(process.env.STATUS_STREAM_POLL_MS) || 1500;
const HEARTBEAT_MS = 15_000;
const MAX_STREAM_MS = 15 * 60 * 1000;
const MAX_STREAMS_PER_USER = 5;

const openStreams = new Map(); // userId -> count

const SNAPSHOT_FIELDS = [
  ...Object.values(STAGES),
  "progress",
  "statusErrors",
].join(" ");

async function buildSnapshot(repoId) {
  const repo = await Repo.findById(repoId, SNAPSHOT_FIELDS).lean();
  if (!repo) return null;
  const job = await getQueueInfo(repoId);
  const statuses = {
    fileStructureStatus: repo.fileStructureStatus || "pending",
    aiStatus: repo.aiStatus || "pending",
    embeddingStatus: repo.embeddingStatus || "pending",
  };
  return {
    statuses,
    progress: computeProgress(repo),
    statusErrors: repo.statusErrors || {},
    job,
    // nothing is running or waiting: no further change is coming
    finished: !job && !Object.values(statuses).some((s) => s === "processing"),
  };
}

const send = (res, event, data) =>
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

// GET /repository/status-stream/:repoId  ->  text/event-stream
//   event: status  {statuses, progress, statusErrors, job, finished}
//                  sent right away, then again whenever something changes
//   event: done    {}   once the analysis has finished (or failed); stream ends
//   event: error   {message}
// Same data as getRepoInfo's status fields, without the polling.
export const streamRepoStatus = asyncHandler(async (req, res) => {
  const userKey = String(req.user._id);
  const count = openStreams.get(userKey) ?? 0;
  if (count >= MAX_STREAMS_PER_USER) {
    throw new ApiError(429, "Too many open progress streams.");
  }

  const repoId = req.repo._id;
  const first = await buildSnapshot(repoId);
  if (!first) throw new ApiError(404, "Repository not found");

  openStreams.set(userKey, count + 1);
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  let closed = false;
  let timer;
  let heartbeat;
  const startedAt = Date.now();

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearInterval(heartbeat);
    const left = (openStreams.get(userKey) ?? 1) - 1;
    if (left > 0) openStreams.set(userKey, left);
    else openStreams.delete(userKey);
    if (!res.writableEnded) res.end();
  };
  res.on("close", close);

  let lastSent = "";
  const emit = (snapshot) => {
    const body = JSON.stringify(snapshot);
    if (body === lastSent) return;
    lastSent = body;
    send(res, "status", snapshot);
  };

  emit(first);
  if (first.finished) {
    send(res, "done", {});
    return close();
  }

  heartbeat = setInterval(
    () => !closed && res.write(": keep-alive\n\n"),
    HEARTBEAT_MS
  );

  const tick = async () => {
    if (closed) return;
    try {
      const snapshot = await buildSnapshot(repoId);
      if (closed) return;
      if (!snapshot) {
        send(res, "error", { message: "Repository not found" });
        return close();
      }
      emit(snapshot);
      if (snapshot.finished) {
        send(res, "done", {});
        return close();
      }
      if (Date.now() - startedAt > MAX_STREAM_MS) {
        // the client can reconnect; this just bounds idle connections
        send(res, "done", { reconnect: true });
        return close();
      }
    } catch (error) {
      logger.error(error, "Status stream failed");
      send(res, "error", { message: "Could not read progress." });
      return close();
    }
    timer = setTimeout(tick, pollMs());
  };
  timer = setTimeout(tick, pollMs());
});
