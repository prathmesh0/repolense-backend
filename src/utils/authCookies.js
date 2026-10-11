// Cookie settings for the access and refresh tokens, in one place.
//
// - httpOnly: scripts cannot read the tokens (XSS cannot steal them).
// - secure: HTTPS only. Browsers still accept it on http://localhost (Chrome,
//   Firefox, Edge); for Safari local development set COOKIE_SECURE=false.
// - sameSite: "lax" by default, which is right when the browser talks to the
//   API through the frontend's own domain (the Next.js /api proxy). Only if the
//   frontend calls this API directly from another domain with cookies would
//   COOKIE_SAMESITE=none be needed.
// - maxAge: matches the token lifetime, so the login survives closing the browser.

const UNITS = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

// "15m", "1d", "10d", "3600" (seconds) -> milliseconds; undefined if unreadable
export function durationToMs(value) {
  if (typeof value === "number") return value * 1000;
  const match = /^\s*(\d+(?:\.\d+)?)\s*([smhdw])?\s*$/i.exec(
    String(value ?? "")
  );
  if (!match) return undefined;
  const unit = match[2] ? UNITS[match[2].toLowerCase()] : 1000;
  return Math.round(Number(match[1]) * unit);
}

const sameSite = () => {
  const v = (process.env.COOKIE_SAMESITE || "lax").toLowerCase();
  return ["lax", "strict", "none"].includes(v) ? v : "lax";
};

const baseOptions = () => ({
  httpOnly: true,
  secure: process.env.COOKIE_SECURE !== "false",
  sameSite: sameSite(),
  path: "/",
});

export const accessCookieOptions = () => ({
  ...baseOptions(),
  maxAge: durationToMs(process.env.ACCESS_TOKEN_EXPIRY),
});

export const refreshCookieOptions = () => ({
  ...baseOptions(),
  maxAge: durationToMs(process.env.REFRESH_TOKEN_EXPIRY),
});

// clearCookie only works when path / sameSite / secure match how it was set
export const clearCookieOptions = () => baseOptions();

export function setAuthCookies(res, accessToken, refreshToken) {
  return res
    .cookie("accessToken", accessToken, accessCookieOptions())
    .cookie("refreshToken", refreshToken, refreshCookieOptions());
}

export function clearAuthCookies(res) {
  return res
    .clearCookie("accessToken", clearCookieOptions())
    .clearCookie("refreshToken", clearCookieOptions());
}
