import { ApiError } from "../utils/apiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { logger } from "../utils/logger.js";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Optional bot check for POST /users/demo-login (Cloudflare Turnstile).
// Off unless TURNSTILE_SECRET is set, so it can be switched on later without
// a code change: set the secret here and send the widget token as
// `captchaToken` in the request body.
export const verifyTurnstile = asyncHandler(async (req, _res, next) => {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return next();

  const token = req.body?.captchaToken;
  const fail = () =>
    new ApiError(400, "Could not verify you are human. Please try again.", [
      { code: "DEMO_CAPTCHA_FAILED" },
    ]);
  if (typeof token !== "string" || !token || token.length > 2048) throw fail();

  let ok = false;
  try {
    const response = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret,
        response: token,
        remoteip: req.ip ?? "",
      }),
      signal: AbortSignal.timeout(5000),
    });
    ok = (await response.json()).success === true;
  } catch (error) {
    logger.warn("Turnstile verification failed: %s", error.message);
  }
  if (!ok) throw fail();
  next();
});
