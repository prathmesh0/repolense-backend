import pino from "pino";
import { format } from "node:util";
import { createRequire } from "node:module";

const isProduction = process.env.NODE_ENV === "production";

// pino-pretty is a dev dependency. If the host installs without dev
// dependencies and NODE_ENV is not set, fall back to plain JSON logs instead
// of crashing at startup.
const hasPretty = (() => {
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
})();

const base = pino({
  level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
  // Pretty output only in development; production stays JSON for log tools
  ...(!isProduction && process.env.NODE_ENV !== "test" && hasPretty
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
