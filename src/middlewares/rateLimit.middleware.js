import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { demoConfig } from "../utils/demoConfig.js";

const buildLimiter = ({ windowMs, limit, message }) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Prefer the authenticated user so shared IPs don't throttle each other
    keyGenerator: (req) =>
      req.user?._id?.toString() ?? ipKeyGenerator(req.ip),
    handler: (req, res) =>
      res.status(429).json({
        success: false,
        message,
        errors: [],
        data: null,
      }),
  });

// Whole API: generic abuse protection
export const globalLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  message: "Too many requests, please try again later.",
});

// Login / register: brute-force protection (always keyed by IP, no user yet)
export const authLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: "Too many authentication attempts, please try again later.",
});

// Repo analysis is expensive (GitHub + embeddings + LLM)
export const analyseLimiter = buildLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: "Analysis limit reached, please try again later.",
});

// Every chat message costs LLM calls
export const chatLimiter = buildLimiter({
  windowMs: 60 * 1000,
  limit: 15,
  message: "You're sending messages too fast, please slow down.",
});

// ---- Demo mode -----------------------------------------------------------
// Always keyed by IP: a guest can clear cookies and mint a new identity, so
// per-user limits alone would not stop a loop.
const demoLimiter = ({ windowMs, limit, message, ...rest }) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    handler: (req, res) =>
      res.status(429).json({
        success: false,
        message,
        errors: [{ code: "DEMO_RATE_LIMITED" }],
        data: null,
      }),
    ...rest,
  });

// Built on first use so the DEMO_* env values are read after dotenv has loaded
const lazy = (build) => {
  let limiter;
  return (req, res, next) => {
    limiter ??= build();
    return limiter(req, res, next);
  };
};

export const demoLoginHourlyLimiter = lazy(() =>
  demoLimiter({
    windowMs: 60 * 60 * 1000,
    limit: demoConfig().loginPerHour,
    message: "Too many demo sessions from your network. Please try later.",
  })
);

export const demoLoginDailyLimiter = lazy(() =>
  demoLimiter({
    windowMs: 24 * 60 * 60 * 1000,
    limit: demoConfig().loginPerDay,
    message:
      "Daily demo limit reached for your network. Please sign up instead.",
  })
);

// Counts only analyses that actually started (201), and only for guests
export const demoIpAnalysisLimiter = lazy(() =>
  demoLimiter({
    windowMs: 24 * 60 * 60 * 1000,
    limit: demoConfig().ipDailyAnalyses,
    message:
      "Daily demo analysis limit reached for your network. Please sign up.",
    skip: (req) => !req.user?.isDemo,
    requestWasSuccessful: (_req, res) => res.statusCode === 201,
    skipFailedRequests: true,
  })
);
