import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { User } from "../../src/models/user.model.js";
import { durationToMs } from "../../src/utils/authCookies.js";
import { clearTestDb, startTestDb, stopTestDb } from "../helpers/db.js";

const API = "/api/v1";
const creds = { email: "alice@example.test", password: "password123" };

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(async () => {
  await clearTestDb();
  await User.create({ username: "alice", ...creds });
});

// supertest gives Set-Cookie as an array of strings
const cookieLine = (res, name) =>
  res.headers["set-cookie"].find((c) => c.startsWith(`${name}=`));
const cookieValue = (line) => line.split(";")[0].split("=")[1];

describe("durationToMs", () => {
  it.each([
    ["15m", 900_000],
    ["1d", 86_400_000],
    ["10d", 864_000_000],
    ["1h", 3_600_000],
    ["3600", 3_600_000],
    [60, 60_000],
  ])("%s", (input, expected) => expect(durationToMs(input)).toBe(expected));

  it("returns undefined for nonsense", () => {
    expect(durationToMs("soon")).toBeUndefined();
    expect(durationToMs(undefined)).toBeUndefined();
  });
});

describe("auth cookies", () => {
  it("login sets httpOnly, secure, SameSite=Lax cookies that last as long as the tokens", async () => {
    const res = await request(app).post(`${API}/users/login`).send(creds);
    expect(res.status).toBe(200);

    for (const [name, seconds] of [
      ["accessToken", 3600], // ACCESS_TOKEN_EXPIRY=1h in tests/helpers/setup.js
      ["refreshToken", 86400], // REFRESH_TOKEN_EXPIRY=1d
    ]) {
      const line = cookieLine(res, name);
      expect(line).toMatch(/HttpOnly/i);
      expect(line).toMatch(/Secure/i);
      expect(line).toMatch(/SameSite=Lax/i);
      expect(line).toMatch(/Path=\//i);
      expect(line).toMatch(new RegExp(`Max-Age=${seconds}`, "i"));
    }
  });

  it("works with the cookie alone, no Authorization header (/users/me)", async () => {
    const login = await request(app).post(`${API}/users/login`).send(creds);
    const access = cookieValue(cookieLine(login, "accessToken"));

    const me = await request(app)
      .get(`${API}/users/me`)
      .set("Cookie", `accessToken=${access}`);
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe(creds.email);
  });

  it("a stale cookie does not override a valid Authorization header", async () => {
    const login = await request(app).post(`${API}/users/login`).send(creds);

    const me = await request(app)
      .get(`${API}/users/me`)
      .set("Cookie", "accessToken=stale.invalid.token")
      .set("Authorization", `Bearer ${login.body.data.accessToken}`);
    expect(me.status).toBe(200);
  });

  it("refresh works from the cookie alone and rotates both cookies", async () => {
    const login = await request(app).post(`${API}/users/login`).send(creds);
    const refresh = cookieValue(cookieLine(login, "refreshToken"));

    const res = await request(app)
      .post(`${API}/users/refresh-token`)
      .set("Cookie", `refreshToken=${refresh}`);
    expect(res.status).toBe(200);
    expect(cookieLine(res, "accessToken")).toMatch(/HttpOnly/i);
    expect(cookieLine(res, "refreshToken")).toMatch(/SameSite=Lax/i);
    // body still carries the tokens for clients that have not moved yet
    expect(res.body.data.accessToken).toBeTruthy();
  });

  it("refresh with no cookie and no body is a clean 401, not a 500", async () => {
    const res = await request(app).post(`${API}/users/refresh-token`);
    expect(res.status).toBe(401);
  });

  it("logout clears both cookies with matching attributes", async () => {
    const login = await request(app).post(`${API}/users/login`).send(creds);
    const access = cookieValue(cookieLine(login, "accessToken"));

    const res = await request(app)
      .post(`${API}/users/logout`)
      .set("Cookie", `accessToken=${access}`);
    expect(res.status).toBe(200);
    for (const name of ["accessToken", "refreshToken"]) {
      const line = cookieLine(res, name);
      expect(line).toMatch(/Expires=Thu, 01 Jan 1970/i);
      expect(line).toMatch(/Path=\//i);
      expect(line).toMatch(/SameSite=Lax/i);
    }
  });

  it("COOKIE_SAMESITE and COOKIE_SECURE can be overridden", async () => {
    process.env.COOKIE_SAMESITE = "none";
    process.env.COOKIE_SECURE = "false";
    try {
      const res = await request(app).post(`${API}/users/login`).send(creds);
      const line = cookieLine(res, "accessToken");
      expect(line).toMatch(/SameSite=None/i);
      expect(line).not.toMatch(/Secure/i);
    } finally {
      delete process.env.COOKIE_SAMESITE;
      delete process.env.COOKIE_SECURE;
    }
  });
});
