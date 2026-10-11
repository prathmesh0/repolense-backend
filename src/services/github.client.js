import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { logger } from "../utils/logger.js";

const MAX_WAIT_SECONDS = 30; // longer than this and we fail fast instead
const REQUEST_TIMEOUT_MS = 20_000;

const ResilientOctokit = Octokit.plugin(retry, throttling);

// One shared client: retries transient 5xx errors, waits out short rate-limit
// windows, and gives up quickly on long ones (the pipeline reports it).
export const octokit = new ResilientOctokit({
  auth: process.env.GITHUB_TOKEN || undefined,
  request: { timeout: REQUEST_TIMEOUT_MS },
  retry: { doNotRetry: [400, 401, 403, 404, 422] },
  throttle: {
    onRateLimit: (retryAfter, options, _octokit, retryCount) => {
      logger.warn(
        "GitHub rate limit hit for %s %s (retry in %ss)",
        options.method,
        options.url,
        retryAfter
      );
      return retryCount < 1 && retryAfter <= MAX_WAIT_SECONDS;
    },
    onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
      logger.warn("GitHub secondary rate limit for %s", options.url);
      return retryCount < 1 && retryAfter <= MAX_WAIT_SECONDS;
    },
  },
});
