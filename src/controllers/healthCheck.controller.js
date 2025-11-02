// controllers/healthCheck.controller.js
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";

const healthCheck = asyncHandler(async (req, res) => {
  try {
    const serverStatus = {
      status: "OK",
      message: "Backend is running successfully 🚀",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
    //   return res
    return res
      .status(201)
      .json(
        new ApiResponse(200, serverStatus, "Backend is running successfully 🚀")
      );
  } catch (error) {
    throw new ApiError(401, error?.message || "Issue in running backend");
  }
});

export { healthCheck };
