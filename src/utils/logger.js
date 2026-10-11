import pino from "pino";
import { format } from "node:util";

const isProduction = process.env.NODE_ENV === "production";

const base = pino({
  level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
  // Pretty output only in development; production stays JSON for log tools
  ...(!isProduction && process.env.NODE_ENV !== "test"
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : {}),
});

// console-style calls: logger.info("loaded %s files", n) or ("msg:", value).
// Never log repository contents or LLM prompts here.
const wrap =
  (level) =>
  (...args) =>
    base[level](format(...args));

export const logger = {
  debug: wrap("debug"),
  info: wrap("info"),
  warn: wrap("warn"),
  error: wrap("error"),
};
