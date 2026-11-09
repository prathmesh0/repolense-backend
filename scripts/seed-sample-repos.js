// Seeds (or refreshes) the demo sample repos: analysed once under a system
// user, flagged isSample, and then read by every demo guest without cost.
//   npm run seed:samples              analyse the ones not ready yet
//   npm run seed:samples -- --refresh re-analyse all of them (repo ids stay the same)
// Which repos: SAMPLE_REPOS (comma-separated GitHub URLs), else the built-in
// trio in src/utils/demoConfig.js.
import "dotenv/config";
import crypto from "node:crypto";
import mongoose from "mongoose";
import connectDB from "../src/db/index.js";
import { Job } from "../src/models/job.model.js";
import { Repo } from "../src/models/repo.model.js";
import { User } from "../src/models/user.model.js";
import {
  fetchGithubRepoMeta,
  ingestRepo,
  parseRepoUrl,
} from "../src/services/repoIngest.service.js";
import { startWorker, stopWorker } from "../src/services/jobQueue.service.js";
import { sampleRepoUrls } from "../src/utils/demoConfig.js";

const refresh = process.argv.includes("--refresh");
const POLL_MS = 3000;

const SYSTEM_EMAIL = "samples@repolens.invalid";

// Owner of all sample repos. Not a demo guest, so the cleanup never touches it,
// and it has a random password nobody knows.
async function getSystemUser() {
  const existing = await User.findOne({ email: SYSTEM_EMAIL });
  if (existing) return existing;
  return User.create({
    username: "repolens-samples",
    email: SYSTEM_EMAIL,
    password: crypto.randomBytes(24).toString("hex"),
  });
}

async function main() {
  await connectDB();
  const owner = await getSystemUser();

  const queued = [];
  for (const raw of sampleRepoUrls()) {
    const parsed = parseRepoUrl(raw);
    if (!parsed) {
      console.warn(`Skipping invalid URL: ${raw}`);
      continue;
    }
    const existing = await Repo.findOne({ url: parsed.url, user: owner._id });
    const ready =
      existing?.fileStructureStatus === "ready" &&
      existing?.embeddingStatus === "ready";
    if (existing && ready && !refresh) {
      console.log(`Already ready: ${parsed.url}`);
      continue;
    }

    const meta = await fetchGithubRepoMeta(parsed.owner, parsed.name);
    const { repo, inProgress } = await ingestRepo({
      userId: owner._id,
      owner: parsed.owner,
      name: parsed.name,
      url: parsed.url,
      meta,
      extra: { isSample: true },
    });
    // Also covers a sample that existed before the flag did
    if (!repo.isSample) await Repo.updateOne({ _id: repo._id }, { isSample: true });
    console.log(
      `${inProgress ? "Already running" : "Queued"}: ${parsed.url} (${repo._id})`
    );
    queued.push(repo._id);
  }

  if (queued.length) {
    // Analyse here; if a server worker grabs a job first, we simply wait for it
    startWorker({ concurrency: 1 });
    while (await Job.exists({ repo: { $in: queued }, active: true })) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    await stopWorker();
  }

  const samples = await Repo.find({ isSample: true }).lean();
  for (const r of samples) {
    console.log(
      `${r.owner}/${r.name}: files=${r.fileStructureStatus} ai=${r.aiStatus} embeddings=${r.embeddingStatus} (${r._id})`
    );
  }
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
