// Standalone worker: runs queued analysis jobs without serving HTTP.
//   npm run worker
// Run the web server with RUN_WORKER=false to keep CPU-heavy embedding off
// the process that answers requests.
import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "./db/index.js";
import {
  requeueStaleJobs,
  startWorker,
  stopWorker,
} from "./services/jobQueue.service.js";
import { startStatusSweeper } from "./services/repoStatus.service.js";
import { logger } from "./utils/logger.js";

await connectDB();
await requeueStaleJobs();
startStatusSweeper();
startWorker();

const shutdown = async (signal) => {
  logger.info("%s received, stopping worker", signal);
  await stopWorker();
  await mongoose.disconnect();
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
