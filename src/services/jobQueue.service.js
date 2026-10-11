import os from "node:os";
import { Job } from "../models/job.model.js";
import { Repo } from "../models/repo.model.js";
import { runAnalysisPipeline } from "./analysisPipeline.service.js";
import { failProcessingStages } from "./repoStatus.service.js";
import { logger } from "../utils/logger.js";

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const POLL_MS = 2_000;
const HEARTBEAT_MS = 30_000;
const LEASE_MS = 2 * 60 * 1000; // a running job with no heartbeat for this long is dead
const RECOVERY_EVERY_MS = 60_000;

const INTERRUPTED_MESSAGE =
  "Analysis was interrupted. Please analyse the repository again.";

// ---------------------------------------------------------------- producer

// Adds an analysis job. If the repo already has a live job, returns it
// instead (the unique partial index makes this race-safe).
export async function enqueueAnalysis(repoId, owner, name) {
  let job;
  let created = true;
  try {
    job = await Job.create({ repo: repoId, payload: { owner, name } });
  } catch (error) {
    if (error.code !== 11000) throw error;
    job = await Job.findOne({ repo: repoId, active: true });
    created = false;
  }
  wakeWorker();
  return { job, created };
}

export const findActiveJob = (repoId) =>
  Job.findOne({ repo: repoId, active: true }).lean();

// What the client can show: waiting in line, running, or nothing active.
export async function getQueueInfo(repoId) {
  const job = await findActiveJob(repoId);
  if (!job) return null;
  const info = { status: job.status, attempts: job.attempts };
  if (job.status === "queued") {
    info.position =
      1 +
      (await Job.countDocuments({
        status: "queued",
        createdAt: { $lt: job.createdAt },
      }));
  }
  return info;
}

// ---------------------------------------------------------------- consumer

// Atomically takes the oldest due job, so several workers never run the same one.
export function claimNextJob() {
  const now = new Date();
  return Job.findOneAndUpdate(
    { status: "queued", runAt: { $lte: now } },
    {
      $set: { status: "running", lockedAt: now, lockedBy: WORKER_ID },
      $inc: { attempts: 1 },
    },
    { sort: { runAt: 1, createdAt: 1 }, returnDocument: "after" }
  );
}

async function finishJob(job, status, error) {
  const set = { status, active: false, finishedAt: new Date() };
  if (error) set.lastError = String(error).slice(0, 300);
  await Job.updateOne({ _id: job._id, status: "running" }, { $set: set });
}

// Jobs whose worker stopped heartbeating (crash, restart, lost machine) are
// retried until maxAttempts, then failed along with the repo's stages.
export async function requeueStaleJobs(leaseMs = LEASE_MS) {
  const cutoff = new Date(Date.now() - leaseMs);
  const stale = await Job.find({
    status: "running",
    lockedAt: { $lt: cutoff },
  }).lean();

  let handled = 0;
  for (const job of stale) {
    if (job.attempts >= job.maxAttempts) {
      const result = await Job.updateOne(
        { _id: job._id, status: "running", lockedAt: job.lockedAt },
        {
          $set: {
            status: "failed",
            active: false,
            finishedAt: new Date(),
            lastError: "Worker stopped responding",
          },
        }
      );
      if (result.modifiedCount) {
        await failProcessingStages({ _id: job.repo }, INTERRUPTED_MESSAGE);
        handled++;
      }
    } else {
      // matching lockedAt means only one recovering worker wins
      const result = await Job.updateOne(
        { _id: job._id, status: "running", lockedAt: job.lockedAt },
        {
          $set: { status: "queued", runAt: new Date() },
          $unset: { lockedAt: 1, lockedBy: 1 },
        }
      );
      if (result.modifiedCount) handled++;
    }
  }
  if (handled) logger.warn("♻️ Recovered %d stale job(s)", handled);
  return handled;
}

// Clears the previous run's state before a (re)run starts
async function prepareRun(repoId) {
  const result = await Repo.updateOne(
    { _id: repoId },
    {
      $set: {
        fileStructureStatus: "processing",
        aiStatus: "processing",
        embeddingStatus: "processing",
        progress: {
          fileStructure: { done: 0, total: 0 },
          embedding: { done: 0, total: 0 },
        },
        statusErrors: {},
      },
    }
  );
  return result.matchedCount > 0;
}

async function runJob(job) {
  const heartbeat = setInterval(() => {
    Job.updateOne(
      { _id: job._id, status: "running" },
      { lockedAt: new Date() }
    ).catch(() => {});
  }, HEARTBEAT_MS);

  try {
    if (!(await prepareRun(job.repo))) {
      await finishJob(job, "failed", "Repository no longer exists");
      return;
    }
    // Records its own stage failures and never throws
    await runAnalysisPipeline(job.repo, job.payload.owner, job.payload.name);
    await finishJob(job, "done");
  } catch (error) {
    logger.error("Job %s crashed: %s", job._id, error.message);
    await failProcessingStages(
      { _id: job.repo },
      "Something went wrong during analysis. Please try again."
    ).catch(() => {});
    await finishJob(job, "failed", error.message).catch(() => {});
  } finally {
    clearInterval(heartbeat);
  }
}

// ------------------------------------------------------------------ worker

let started = false;
let stopping = false;
let ticking = false;
let timer = null;
let concurrency = 1;
let lastRecovery = 0;
const running = new Set();

async function tick() {
  if (!started || stopping || ticking) return;
  ticking = true;
  clearTimeout(timer);
  try {
    if (Date.now() - lastRecovery > RECOVERY_EVERY_MS) {
      lastRecovery = Date.now();
      await requeueStaleJobs();
    }
    while (running.size < concurrency && !stopping) {
      const job = await claimNextJob();
      if (!job) break;
      const promise = runJob(job).finally(() => {
        running.delete(promise);
        wakeWorker();
      });
      running.add(promise);
    }
  } catch (error) {
    logger.error("Worker tick failed: %s", error.message);
  } finally {
    ticking = false;
    if (started && !stopping) timer = setTimeout(tick, POLL_MS);
  }
}

// Run a poll right away instead of waiting for the next interval
export function wakeWorker() {
  if (started && !stopping) setImmediate(tick);
}

export function startWorker({ concurrency: n } = {}) {
  if (started) return;
  concurrency = Math.max(1, Number(n ?? process.env.JOB_CONCURRENCY) || 1);
  started = true;
  stopping = false;
  logger.info(
    "👷 Job worker %s started (concurrency %d)",
    WORKER_ID,
    concurrency
  );
  tick();
}

// Stops taking new jobs and waits for running ones. Anything still running
// after the timeout is recovered by the lease logic on the next start.
export async function stopWorker({ timeoutMs = 25_000 } = {}) {
  if (!started) return;
  stopping = true;
  clearTimeout(timer);
  await Promise.race([
    Promise.allSettled([...running]),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  started = false;
  logger.info("👷 Job worker stopped");
}
