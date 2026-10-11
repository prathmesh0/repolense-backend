import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { globalLimiter } from "./middlewares/rateLimit.middleware.js";

// Exact origins only. Wildcards like "*.vercel.app" would also match
// anyone else's Vercel deployment.
const allowedOrigins = [
  process.env.CORS_ORIGIN,
  "https://repolens-frontend.vercel.app",
  "http://localhost:3000",
].filter(Boolean);

const app = express();

// Behind a hosting proxy; needed so rate limiting sees the real client IP
app.set("trust proxy", 1);

app.use(
  cors({
    origin: (origin, callback) => {
      // Non-browser clients (curl, server-to-server) send no Origin header
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

app.use(globalLimiter);

app.use(
  express.json({
    limit: "16kb",
  })
);

app.use(express.urlencoded({ extended: true, limit: "16kb" }));
app.use(express.static("public"));
app.use(cookieParser());

// routes import
import userRouter from "./routes/user.routes.js";
import repoRouter from "./routes/repo.routes.js";
import chatRouter from "./routes/chat.routes.js";
import healthCheckRouter from "./routes/healthCheck.routes.js";
import { errorHandler } from "./middlewares/errorHandler.js";

// routes declaration
app.use("/api/v1/users", userRouter);
app.use("/api/v1/repository", repoRouter);
app.use("/api/v1/aiChat", chatRouter);
app.use("/api/v1/health", healthCheckRouter);

// ERROR HANDLER (must be last)
app.use(errorHandler);

// http://localhost:8000/api/v1/users/register

export { app };
