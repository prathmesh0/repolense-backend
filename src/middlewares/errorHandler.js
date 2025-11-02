/* eslint-disable no-unused-vars */
import { ApiError } from "../utils/apiError.js";

export const errorHandler = (err, req, res, next) => {
  console.error(err);

  if (err instanceof ApiError) {
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Something went wrong",
      errors: err.errors || [],
      data: null,
    });
  }

  return res.status(500).json({
    success: false,
    message: err.message || "Internal Server Error",
    errors: [],
    data: null,
  });
};
