import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
const allowedOrigins = [
  process.env.CORS_ORIGIN,
  "https://repolens-frontend.vercel.app",
];

const app = express();

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin like mobile apps or curl
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

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
