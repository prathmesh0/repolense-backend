import crypto from "node:crypto";
import { User } from "../models/user.model.js";
import { Repo } from "../models/repo.model.js";
import { File } from "../models/file.model.js";
import { Embedding } from "../models/embedding.model.js";
import { Analysis } from "../models/analysis.model.js";
import { Chat } from "../models/chat.model.js";
import { ChatMessage } from "../models/chatMessage.model.js";
import { Job } from "../models/job.model.js";
import { demoConfig } from "../utils/demoConfig.js";
import { logger } from "../utils/logger.js";

// ------------------------------------------------------------------ guests

// Creates a temporary guest. It has no usable password: nobody can log in as
// it except through the token issued here.
export async function createDemoUser() {
  const { ttlMinutes } = demoConfig();
  const suffix = crypto.randomBytes(5).toString("hex");
  const username = `demo-${suffix}`;
  const user = await User.create({
    username,
    email: `${username}@demo.invalid`,
    password: crypto.randomBytes(24).toString("hex"),
    isDemo: true,
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
  });
  const accessToken = user.generateAccessToken(`${ttlMinutes}m`);
  return { user, accessToken };
}

// What the client shows in the demo banner
export function demoInfo(user) {
  const { maxAnalyses, maxChats } = demoConfig();
  return {
    analysesUsed: user.demoAnalysesUsed ?? 0,
    analysesMax: maxAnalyses,
    chatUsed: user.demoChatCount ?? 0,
    chatMax: maxChats,
    expiresAt: user.expiresAt,
  };
}

export const isDemoExpired = (user) =>
  Boolean(user.isDemo && user.expiresAt && user.expiresAt <= new Date());

// ------------------------------------------------------------------ quotas
// Atomic: the filter holds the limit, so two parallel requests cannot both
// take the last slot.

export const reserveAnalysis = (userId) =>
  User.findOneAndUpdate(
    {
      _id: userId,
      isDemo: true,
      demoAnalysesUsed: { $lt: demoConfig().maxAnalyses },
    },
    { $inc: { demoAnalysesUsed: 1 } },
    { new: true }
  );

export const refundAnalysis = (userId) =>
  User.updateOne(
    { _id: userId, demoAnalysesUsed: { $gt: 0 } },
    { $inc: { demoAnalysesUsed: -1 } }
  );

export const reserveChat = (userId) =>
  User.findOneAndUpdate(
    {
      _id: userId,
      isDemo: true,
      demoChatCount: { $lt: demoConfig().maxChats },
    },
    { $inc: { demoChatCount: 1 } },
    { new: true }
  );

export const refundChat = (userId) =>
  User.updateOne(
    { _id: userId, demoChatCount: { $gt: 0 } },
    { $inc: { demoChatCount: -1 } }
  );

// ---------------------------------------------------------------- deletion

// Deletes the given repos and everything hanging off them
async function deleteRepoData(repoIds) {
  if (!repoIds.length) return;
  const byRepo = { repo: { $in: repoIds } };
  await Promise.all([
    Embedding.deleteMany(byRepo),
    File.deleteMany(byRepo),
    Analysis.deleteMany(byRepo),
    ChatMessage.deleteMany(byRepo),
    Chat.deleteMany(byRepo),
    Job.deleteMany(byRepo),
  ]);
  await Repo.deleteMany({ _id: { $in: repoIds }, isSample: { $ne: true } });
}

// Removes a guest and everything it owns: its repos (with files, embeddings,
// analysis, chats, jobs) and its own chats on shared sample repos. Never
// touches sample repos themselves, and refuses to delete a real user.
export async function deleteDemoUser(userId) {
  const user = await User.findOne({ _id: userId, isDemo: true }, "_id").lean();
  if (!user) return false;

  const repos = await Repo.find({ user: user._id, isSample: { $ne: true } }, "_id")
    .lean();
  await deleteRepoData(repos.map((r) => r._id));

  // The guest's private chats on shared sample repos
  await Promise.all([
    ChatMessage.deleteMany({ user: user._id }),
    Chat.deleteMany({ user: user._id }),
  ]);
  await User.deleteOne({ _id: user._id, isDemo: true });
  return true;
}

// Deletes expired guests, then repos whose guest is already gone (safety net
// for a crash between the two steps, or a job that kept writing after delete).
export async function sweepExpiredDemo() {
  const expired = await User.find(
    { isDemo: true, expiresAt: { $lte: new Date() } },
    "_id"
  ).lean();
  let users = 0;
  for (const { _id } of expired) {
    if (await deleteDemoUser(_id)) users++;
  }

  const guestRepos = await Repo.find({ ownerIsDemo: true }, "_id user").lean();
  let orphans = 0;
  if (guestRepos.length) {
    const alive = new Set(
      (
        await User.find(
          { _id: { $in: guestRepos.map((r) => r.user) } },
          "_id"
        ).lean()
      ).map((u) => String(u._id))
    );
    const orphanIds = guestRepos
      .filter((r) => !alive.has(String(r.user)))
      .map((r) => r._id);
    await deleteRepoData(orphanIds);
    orphans = orphanIds.length;
  }

  if (users || orphans) {
    logger.info(
      { event: "demo_cleanup", users, orphanRepos: orphans },
      "Demo cleanup"
    );
  }
  return { users, orphans };
}

let cleanupTimer = null;

export function startDemoCleanup() {
  if (cleanupTimer) return;
  const run = () =>
    sweepExpiredDemo().catch((error) =>
      logger.error("Demo cleanup failed: %s", error.message)
    );
  run();
  cleanupTimer = setInterval(run, demoConfig().cleanupMinutes * 60_000);
  cleanupTimer.unref();
}

export function stopDemoCleanup() {
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}
