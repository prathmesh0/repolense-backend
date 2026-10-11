import rateLimit, { ipKeyGenerator } from "express-rate-limit";

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
