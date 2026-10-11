import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose from "mongoose";

const pipeline = vi.hoisted(() => ({ runAnalysisPipeline: vi.fn() }));
vi.mock("../../src/services/analysisPipeline.service.js", () => pipeline);

import { Job } from "../../src/models/job.model.js";
import { Repo } from "../../src/models/repo.model.js";
import {
  claimNextJob,
  enqueueAnalysis,
  getQueueInfo,
  requeueStaleJobs,
  startWorker,
  stopWorker,
} from "../../src/services/jobQueue.service.js";
import { sweepStuckRepos } from "../../src/services/repoStatus.service.js";
import { clearTestDb, startTestDb, stopTestDb } from "../helpers/db.js";

const userId = new mongoose.Types.ObjectId();
const makeRepo = (over = {}) =>
  Repo.create({
    name: "demo",
    owner: "someone",
    url: `https://github.com/someone/demo-${Math.random()}`,
    user: userId,
    ...over,
  });

async function waitFor(check, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

beforeAll(async () => {
  await startTestDb();
  await Job.init();
});
afterAll(stopTestDb);
beforeEach(async () => {
  await clearTestDb();
  pipeline.runAnalysisPipeline.mockReset();
  pipeline.runAnalysisPipeline.mockResolvedValue(undefined);
});
afterEach(async () => {
  await stopWorker({ timeoutMs: 2000 });
});

describe("enqueue", () => {
  it("keeps one live job per repo, and allows a new one after it finishes", async () => {
    const repo = await makeRepo();

    const first = await enqueueAnalysis(repo._id, "someone", "demo");
    const second = await enqueueAnalysis(repo._id, "someone", "demo");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(String(second.job._id)).toBe(String(first.job._id));
    expect(await Job.countDocuments({ repo: repo._id })).toBe(1);

    await Job.updateOne(
      { _id: first.job._id },
      { status: "done", active: false, finishedAt: new Date() }
    );
    const third = await enqueueAnalysis(repo._id, "someone", "demo");
    expect(third.created).toBe(true);
    expect(await Job.countDocuments({ repo: repo._id })).toBe(2);
  });

  it("reports queue position for waiting jobs", async () => {
    const a = await makeRepo();
    const b = await makeRepo();
    await enqueueAnalysis(a._id, "o", "a");
    await new Promise((r) => setTimeout(r, 5));
    await enqueueAnalysis(b._id, "o", "b");

    expect(await getQueueInfo(a._id)).toMatchObject({
      status: "queued",
      position: 1,
    });
    expect(await getQueueInfo(b._id)).toMatchObject({
      status: "queued",
      position: 2,
    });
  });
});

describe("claiming", () => {
  it("hands a job to exactly one of several concurrent claimers", async () => {
    const repo = await makeRepo();
    await enqueueAnalysis(repo._id, "o", "r");

    const results = await Promise.all(
      Array.from({ length: 6 }, () => claimNextJob())
    );
    const claimed = results.filter(Boolean);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe("running");
    expect(claimed[0].attempts).toBe(1);
  });

  it("serves the oldest job first", async () => {
    const a = await makeRepo();
    const b = await makeRepo();
    await enqueueAnalysis(a._id, "o", "a");
    await new Promise((r) => setTimeout(r, 5));
    await enqueueAnalysis(b._id, "o", "b");

    const first = await claimNextJob();
    expect(String(first.repo)).toBe(String(a._id));
  });
});

describe("worker", () => {
  it("runs a queued job: resets the repo run state, then marks the job done", async () => {
    const repo = await makeRepo({
      fileStructureStatus: "failed",
      statusErrors: { ai: "old error" },
    });
    let seenDuringRun;
    pipeline.runAnalysisPipeline.mockImplementation(async (id) => {
      seenDuringRun = await Repo.findById(id).lean();
    });

    const { job } = await enqueueAnalysis(repo._id, "someone", "demo");
    startWorker({ concurrency: 1 });

    await waitFor(async () => (await Job.findById(job._id)).status === "done");
    const done = await Job.findById(job._id).lean();
    expect(done.active).toBe(false);
    expect(done.finishedAt).toBeTruthy();
    expect(pipeline.runAnalysisPipeline).toHaveBeenCalledWith(
      repo._id,
      "someone",
      "demo"
    );
    expect(seenDuringRun.fileStructureStatus).toBe("processing");
    expect(seenDuringRun.statusErrors?.ai).toBeUndefined();
  });

  it("respects the concurrency limit", async () => {
    const first = deferred();
    const calls = [];
    pipeline.runAnalysisPipeline.mockImplementation(async (id) => {
      calls.push(String(id));
      if (calls.length === 1) await first.promise;
    });

    const a = await makeRepo();
    const b = await makeRepo();
    await enqueueAnalysis(a._id, "o", "a");
    await new Promise((r) => setTimeout(r, 5));
    await enqueueAnalysis(b._id, "o", "b");
    startWorker({ concurrency: 1 });

    await waitFor(() => calls.length === 1);
    // give the worker time to (wrongly) start the second job
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toHaveLength(1);

    first.resolve();
    await waitFor(() => calls.length === 2);
    expect(calls).toEqual([String(a._id), String(b._id)]);
  });

  it("fails the job and the repo's stages if the pipeline crashes", async () => {
    pipeline.runAnalysisPipeline.mockRejectedValue(new Error("boom"));
    const repo = await makeRepo();
    const { job } = await enqueueAnalysis(repo._id, "o", "r");
    startWorker({ concurrency: 1 });

    await waitFor(
      async () => (await Job.findById(job._id)).status === "failed"
    );
    const saved = await Repo.findById(repo._id).lean();
    expect(saved.aiStatus).toBe("failed");
    expect(saved.embeddingStatus).toBe("failed");
    expect(saved.statusErrors.ai).toMatch(/something went wrong/i);
  });
});

describe("graceful shutdown", () => {
  it("waits for the running job to finish before stopping", async () => {
    const gate = deferred();
    let started = false;
    pipeline.runAnalysisPipeline.mockImplementation(async () => {
      started = true;
      await gate.promise;
    });
    const repo = await makeRepo();
    const { job } = await enqueueAnalysis(repo._id, "o", "r");
    startWorker({ concurrency: 1 });
    await waitFor(() => started);

    let stopped = false;
    const stopping = stopWorker({ timeoutMs: 5000 }).then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(stopped).toBe(false); // still waiting for the job

    gate.resolve();
    await stopping;
    expect((await Job.findById(job._id)).status).toBe("done");
  });

  it("gives up after the timeout and leaves the job for lease recovery", async () => {
    pipeline.runAnalysisPipeline.mockImplementation(
      () => new Promise(() => {})
    );
    const repo = await makeRepo();
    const { job } = await enqueueAnalysis(repo._id, "o", "r");
    startWorker({ concurrency: 1 });
    await waitFor(
      async () => (await Job.findById(job._id)).status === "running"
    );

    await stopWorker({ timeoutMs: 150 });

    // still marked running; requeueStaleJobs will pick it up once the lease expires
    expect((await Job.findById(job._id)).status).toBe("running");
  });
});

describe("crash recovery", () => {
  const runningJob = (repoId, over = {}) =>
    Job.create({
      repo: repoId,
      payload: { owner: "o", name: "r" },
      status: "running",
      attempts: 1,
      lockedAt: new Date(Date.now() - 10 * 60 * 1000),
      lockedBy: "dead-worker",
      ...over,
    });

  it("re-queues a job whose worker stopped heartbeating", async () => {
    const repo = await makeRepo();
    const job = await runningJob(repo._id);

    expect(await requeueStaleJobs(2 * 60 * 1000)).toBe(1);
    const saved = await Job.findById(job._id).lean();
    expect(saved.status).toBe("queued");
    expect(saved.lockedBy).toBeUndefined();
    expect(saved.active).toBe(true);
  });

  it("leaves a job with a fresh heartbeat alone", async () => {
    const repo = await makeRepo();
    const job = await runningJob(repo._id, { lockedAt: new Date() });

    expect(await requeueStaleJobs(2 * 60 * 1000)).toBe(0);
    expect((await Job.findById(job._id)).status).toBe("running");
  });

  it("fails the job and the repo after the last attempt", async () => {
    const repo = await makeRepo({
      fileStructureStatus: "ready",
      aiStatus: "processing",
      embeddingStatus: "processing",
    });
    const job = await runningJob(repo._id, { attempts: 2, maxAttempts: 2 });

    await requeueStaleJobs(2 * 60 * 1000);
    const saved = await Job.findById(job._id).lean();
    expect(saved.status).toBe("failed");
    expect(saved.active).toBe(false);

    const r = await Repo.findById(repo._id).lean();
    expect(r.aiStatus).toBe("failed");
    expect(r.embeddingStatus).toBe("failed");
    expect(r.statusErrors.ai).toMatch(/interrupted/i);
  });

  it("status sweep skips repos that still have a live job", async () => {
    const withJob = await makeRepo({
      aiStatus: "processing",
      embeddingStatus: "processing",
    });
    const orphan = await makeRepo({
      aiStatus: "processing",
      embeddingStatus: "processing",
    });
    await enqueueAnalysis(withJob._id, "o", "r");
    const old = new Date(Date.now() - 20 * 60 * 1000);
    await Repo.collection.updateMany(
      { _id: { $in: [withJob._id, orphan._id] } },
      { $set: { updatedAt: old } }
    );

    await sweepStuckRepos(15 * 60 * 1000);

    expect((await Repo.findById(withJob._id)).aiStatus).toBe("processing");
    expect((await Repo.findById(orphan._id)).aiStatus).toBe("failed");
  });
});
