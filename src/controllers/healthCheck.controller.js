// controllers/healthCheck.controller.js
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/apiResponse.js";

const healthCheck = asyncHandler(async (req, res) => {
  // readyState 1 = connected; ping confirms the database actually answers
  let database = "down";
  try {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.admin().ping();
      database = "up";
    }
  } catch {
    database = "down";
  }

  const healthy = database === "up";
  const serverStatus = {
    status: healthy ? "OK" : "DEGRADED",
    database,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };

  return res
    .status(healthy ? 200 : 503)
    .json(
      new ApiResponse(
        healthy ? 200 : 503,
        serverStatus,
        healthy ? "Backend is running successfully 🚀" : "Database unavailable"
      )
    );
});

export { healthCheck };
