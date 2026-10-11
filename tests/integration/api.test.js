import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { app } from "../../src/app.js";
import { User } from "../../src/models/user.model.js";
import { Repo } from "../../src/models/repo.model.js";
import { Chat } from "../../src/models/chat.model.js";
import { clearTestDb, startTestDb, stopTestDb } from "../helpers/db.js";

const API = "/api/v1";

async function createUser(name) {
  const user = await User.create({
    username: name,
    email: `${name}@example.test`,
    password: "password123",
  });
  return { user, token: user.generateAccessToken() };
}

const createRepo = (user, over = {}) =>
  Repo.create({
    name: "demo",
    owner: "someone",
    url: `https://github.com/someone/demo-${Math.random()}`,
    user: user._id,
    ...over,
  });

const auth = (token) => ({ Authorization: `Bearer ${token}` });

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(clearTestDb);

describe("repository access", () => {
  it("requires login for getRepoInfo", async () => {
    const res = await request(app).get(`${API}/repository/getRepoInfo/abc`);
    expect(res.status).toBe(401);
  });

  it("lets the owner read their repo, with status and progress", async () => {
    const { user, token } = await createUser("alice");
    const repo = await createRepo(user, { embeddingStatus: "ready" });

    const res = await request(app)
      .get(`${API}/repository/getRepoInfo/${repo._id}?info=basicAnalysis`)
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data.basicInfo.name).toBe("demo");
    expect(res.body.data.statuses.embeddingStatus).toBe("ready");
    expect(res.body.data.progress).toHaveProperty("percent");
    expect(res.body.data.statusErrors).toEqual({});
  });

  it("returns 404 for another user's repo and 400 for a bad id", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const repo = await createRepo(alice.user);

    const foreign = await request(app)
      .get(`${API}/repository/getRepoInfo/${repo._id}`)
      .set(auth(bob.token));
    expect(foreign.status).toBe(404);

    const missing = await request(app)
      .get(`${API}/repository/getRepoInfo/${new mongoose.Types.ObjectId()}`)
      .set(auth(alice.token));
    expect(missing.status).toBe(404);

    const bad = await request(app)
      .get(`${API}/repository/getRepoInfo/not-an-id`)
      .set(auth(alice.token));
    expect(bad.status).toBe(400);
  });
});

describe("chat access and validation", () => {
  it("blocks chat and history on someone else's repo", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const repo = await createRepo(alice.user);

    const chat = await request(app)
      .post(`${API}/aiChat/chat/${repo._id}`)
      .set(auth(bob.token))
      .send({ question: "what is this?" });
    expect(chat.status).toBe(404);

    const history = await request(app)
      .get(`${API}/aiChat/chat-history/${repo._id}`)
      .set(auth(bob.token));
    expect(history.status).toBe(404);
  });

  it.each([
    ["missing", {}],
    ["blank", { question: "   " }],
    ["not a string", { question: { $ne: "" } }],
    ["too long", { question: "x".repeat(2001) }],
  ])("rejects a %s question", async (_label, body) => {
    const { user, token } = await createUser("alice");
    const repo = await createRepo(user);

    const res = await request(app)
      .post(`${API}/aiChat/chat/${repo._id}`)
      .set(auth(token))
      .send(body);
    expect(res.status).toBe(400);
  });

  it("history is read-only: empty result, no chat document created", async () => {
    const { user, token } = await createUser("alice");
    const repo = await createRepo(user);

    const res = await request(app)
      .get(`${API}/aiChat/chat-history/${repo._id}`)
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data.messages).toEqual([]);
    expect(await Chat.countDocuments({ repo: repo._id })).toBe(0);
  });
});

describe("auth input validation", () => {
  it("rejects operator objects on login", async () => {
    await createUser("alice");
    const res = await request(app)
      .post(`${API}/users/login`)
      .send({ email: { $ne: "" }, password: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects non-string fields on register", async () => {
    const res = await request(app)
      .post(`${API}/users/register`)
      .send({ username: "u", email: { $gt: "" }, password: "pw" });
    expect(res.status).toBe(400);
  });

  it("logs in with correct credentials and sets httpOnly cookies", async () => {
    await createUser("alice");
    const res = await request(app)
      .post(`${API}/users/login`)
      .send({ email: "alice@example.test", password: "password123" });

    expect(res.status).toBe(200);
    const cookies = res.headers["set-cookie"];
    expect(cookies.length).toBeGreaterThanOrEqual(2);
    expect(cookies.every((c) => /HttpOnly/i.test(c))).toBe(true);
  });
});

describe("CORS", () => {
  it("allows the configured and default frontends", async () => {
    for (const origin of [
      "https://app.example.test",
      "https://repolens-frontend.vercel.app",
    ]) {
      const res = await request(app)
        .get(`${API}/health/healthcheck`)
        .set("Origin", origin);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
    }
  });

  it("does not allow other origins, including other vercel.app sites", async () => {
    const res = await request(app)
      .get(`${API}/health/healthcheck`)
      .set("Origin", "https://evil.vercel.app");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("health check", () => {
  it("reports the database as up", async () => {
    const res = await request(app).get(`${API}/health/healthcheck`);
    expect(res.status).toBe(200);
    expect(res.body.data.database).toBe("up");
  });
});
