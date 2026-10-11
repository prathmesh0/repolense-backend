// Must be first: loads .env before any other module reads process.env
import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "./db/index.js";
import { app } from "./app.js";
import { startStatusSweeper } from "./services/repoStatus.service.js";
import {
  requeueStaleJobs,
  startWorker,
  stopWorker,
} from "./services/jobQueue.service.js";
import { logger } from "./utils/logger.js";

connectDB()
  .then(async () => {
    // Retry or fail analyses that were running when the previous process died
    await requeueStaleJobs();
    // Fail repos left "processing" with no job behind them
    startStatusSweeper();

    // RUN_WORKER=false keeps analysis off this process (use `npm run worker`)
    const runWorker = process.env.RUN_WORKER !== "false";
    if (runWorker) startWorker();

    const server = app.listen(process.env.PORT || 8000, () => {
      logger.info(`Server is running at port : ${process.env.PORT}`);
    });

    const shutdown = async (signal) => {
      logger.info("%s received, shutting down", signal);
      server.close();
      await stopWorker();
      await mongoose.disconnect();
      process.exit(0);
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  })
  .catch((error) => {
    logger.error("Startup failed !!", error);
  });
