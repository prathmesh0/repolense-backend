import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";

const app = express();

app.use(
  cors({
    origin: process.env.CORS_ORIGIN,
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
