import { ApiError } from "../utils/apiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { reserveChat, refundChat } from "../services/demo.service.js";
import { demoConfig } from "../utils/demoConfig.js";
import { logger } from "../utils/logger.js";

// Per-session chat cap for demo guests; a no-op for real users. The message
// is reserved atomically before the model runs and given back if the request
// fails before an answer (any 4xx/5xx status).
export const demoChatQuota = asyncHandler(async (req, res, next) => {
  if (!req.user?.isDemo) return next();

  const updated = await reserveChat(req.user._id);
  if (!updated) {
    logger.info({ event: "demo_limit_hit", kind: "chat" }, "Demo limit hit");
    throw new ApiError(
      429,
      `Demo chat limit reached (${demoConfig().maxChats} messages). Sign up to keep chatting.`,
      [{ code: "DEMO_CHAT_LIMIT_REACHED" }]
    );
  }

  logger.info({ event: "demo_chat" }, "Demo chat");
  res.on("finish", () => {
    if (res.statusCode >= 400) refundChat(req.user._id).catch(() => {});
  });
  next();
});
