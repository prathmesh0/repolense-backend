import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";

// Small numbers so limits are easy to hit. Limiters read these on first use.
process.env.DEMO_LOGIN_PER_HOUR = "1000";
process.env.DEMO_LOGIN_PER_DAY = "50";
process.env.DEMO_IP_DAILY_ANALYSES = "1000";
process.env.DEMO_CHAT_MAX = "2";

const octokitMock = vi.hoisted(() => ({
  repos: {
    get: vi.fn(),
    listBranches: vi.fn(),
    listContributors: vi.fn(),
    listLanguages: vi.fn(),
    listCommits: vi.fn(),
  },
}));
vi.mock("../../src/services/github.client.js", () => ({
  octokit: octokitMock,
}));

const llm = vi.hoisted(() => ({
  askLLM: vi.fn(),
  askLLMStream: vi.fn(),
  embedText: vi.fn(),
  findSimilarChunks: vi.fn(),
}));
vi.mock("../../src/services/llm.service.js", () => ({
  askLLM: llm.askLLM,
  askLLMStream: llm.askLLMStream,
}));
vi.mock("../../src/services/embeddingModel.js", () => ({
  embedText: llm.embedText,
}));
vi.mock("../../src/services/retrieval.service.js", () => ({
  findSimilarChunks: llm.findSimilarChunks,
}));

import { app } from "../../src/app.js";
import { Chat } from "../../src/models/chat.model.js";
import { ChatMessage } from "../../src/models/chatMessage.model.js";
import { Embedding } from "../../src/models/embedding.model.js";
import { File } from "../../src/models/file.model.js";
import { Job } from "../../src/models/job.model.js";
import { Repo } from "../../src/models/repo.model.js";
import { User } from "../../src/models/user.model.js";
import { claimNextJob } from "../../src/services/jobQueue.service.js";
import {
  deleteDemoUser,
  sweepExpiredDemo,
} from "../../src/services/demo.service.js";
import { clearTestDb, startTestDb, stopTestDb } from "../helpers/db.js";

const API = "/api/v1";
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

const startDemo = async () => {
  const res = await request(app).post(`${API}/users/demo-login`);
  return {
    res,
    token: res.body.data?.accessToken,
    id: res.body.data?.user?._id,
    headers: bearer(res.body.data?.accessToken),
  };
};

const analyse = (headers, name) =>
  request(app)
    .post(`${API}/repository/analyse`)
    .set(headers)
    .send({ url: `https://github.com/someone/${name}` });

async function sampleRepo(over = {}) {
  const owner = await User.create({
    username: "repolens-samples",
    email: "samples@repolens.invalid",
    password: "password123",
  });
  const repo = await Repo.create({
    name: "sample",
    owner: "someone",
    url: "https://github.com/someone/sample",
    user: owner._id,
    isSample: true,
    languages: ["JavaScript"],
    fileStructureStatus: "ready",
    aiStatus: "ready",
    embeddingStatus: "ready",
    ...over,
  });
  return repo;
}

beforeAll(async () => {
  await startTestDb();
  await Job.init();
  await Repo.init();
  await User.init();
});
afterAll(stopTestDb);
beforeEach(async () => {
  await clearTestDb();
  vi.clearAllMocks();
  delete process.env.DEMO_ENABLED;
  octokitMock.repos.get.mockImplementation(async ({ repo }) => ({
    data: {
      name: repo,
      stargazers_count: 3,
      forks_count: 1,
      description: "d",
      private: false,
      size: 100,
    },
  }));
  octokitMock.repos.listBranches.mockResolvedValue({ data: [{ name: "main" }] });
  octokitMock.repos.listContributors.mockResolvedValue({
    data: [{ login: "a" }],
  });
  octokitMock.repos.listLanguages.mockResolvedValue({ data: { JavaScript: 1 } });
  octokitMock.repos.listCommits.mockResolvedValue({ headers: {}, data: [{}] });
  llm.embedText.mockResolvedValue([0.1, 0.2]);
  llm.findSimilarChunks.mockResolvedValue([
    { path: "a.js", contentPreview: "code" },
  ]);
  llm.askLLM.mockResolvedValue("an answer");
});

describe("POST /users/demo-login", () => {
  it("creates a guest with a session cookie, no refresh token, and a token", async () => {
    const { res, id } = await startDemo();

    expect(res.status).toBe(200);
    expect(res.body.data.user.isDemo).toBe(true);
    expect(res.body.data.user.email).toBeUndefined();
    expect(res.body.data.user.demo).toMatchObject({
      analysesUsed: 0,
      analysesMax: 2,
    });
    expect(res.body.data.refreshToken).toBeUndefined();

    const cookies = res.headers["set-cookie"];
    const access = cookies.find((c) => c.startsWith("accessToken="));
    expect(access).toMatch(/HttpOnly/i);
    expect(access).not.toMatch(/Max-Age|Expires/i); // browser-session cookie
    expect(cookies.some((c) => /^refreshToken=;/.test(c))).toBe(true); // cleared, not set

    const user = await User.findById(id);
    expect(user.isDemo).toBe(true);
    expect(user.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(user.refreshToken).toBeUndefined();
  });

  it("returns 503 DEMO_DISABLED when the kill switch is off", async () => {
    process.env.DEMO_ENABLED = "false";
    const res = await request(app).post(`${API}/users/demo-login`);
    expect(res.status).toBe(503);
    expect(res.body.errors).toEqual([{ code: "DEMO_DISABLED" }]);
    expect(await User.countDocuments({ isDemo: true })).toBe(0);
  });
});

describe("optional captcha", () => {
  const verifyResponse = (success) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      json: async () => ({ success }),
    });

  it("is skipped when TURNSTILE_SECRET is not set", async () => {
    const spy = verifyResponse(true);
    const res = await request(app).post(`${API}/users/demo-login`);
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("requires a valid token once TURNSTILE_SECRET is set", async () => {
    process.env.TURNSTILE_SECRET = "secret";
    try {
      const missing = await request(app).post(`${API}/users/demo-login`);
      expect(missing.status).toBe(400);
      expect(missing.body.errors).toEqual([{ code: "DEMO_CAPTCHA_FAILED" }]);

      const bad = verifyResponse(false);
      const rejected = await request(app)
        .post(`${API}/users/demo-login`)
        .send({ captchaToken: "bad" });
      expect(rejected.status).toBe(400);
      bad.mockRestore();

      const good = verifyResponse(true);
      const accepted = await request(app)
        .post(`${API}/users/demo-login`)
        .send({ captchaToken: "good" });
      expect(accepted.status).toBe(200);
      expect(good).toHaveBeenCalledOnce();
      good.mockRestore();
      expect(await User.countDocuments({ isDemo: true })).toBe(1);
    } finally {
      delete process.env.TURNSTILE_SECRET;
    }
  });
});

describe("guest session", () => {
  it("GET /users/me reports the demo block; real users get isDemo false", async () => {
    const { headers } = await startDemo();
    const me = await request(app).get(`${API}/users/me`).set(headers);
    expect(me.body.data.isDemo).toBe(true);
    expect(me.body.data.demo.analysesMax).toBe(2);
    expect(me.body.data.demo.expiresAt).toBeTruthy();

    const real = await User.create({
      username: "alice",
      email: "alice@example.test",
      password: "password123",
    });
    const realMe = await request(app)
      .get(`${API}/users/me`)
      .set(bearer(real.generateAccessToken()));
    expect(realMe.body.data.isDemo).toBe(false);
    expect(realMe.body.data.demo).toBeUndefined();
    expect(realMe.body.data.email).toBe("alice@example.test");
  });

  it("rejects an expired guest with 401", async () => {
    const { headers, id } = await startDemo();
    await User.updateOne({ _id: id }, { expiresAt: new Date(Date.now() - 1000) });
    const res = await request(app).get(`${API}/users/me`).set(headers);
    expect(res.status).toBe(401);
  });

  it("cannot refresh (no refresh token)", async () => {
    await startDemo();
    const res = await request(app).post(`${API}/users/refresh-token`).send({});
    expect(res.status).toBe(401);
  });
});

describe("analysis quota", () => {
  it("allows 2 analyses, then 403 DEMO_LIMIT_REACHED, and counts them", async () => {
    const { headers, id } = await startDemo();

    expect((await analyse(headers, "one")).status).toBe(201);
    expect((await analyse(headers, "two")).status).toBe(201);
    const third = await analyse(headers, "three");

    expect(third.status).toBe(403);
    expect(third.body.errors).toEqual([{ code: "DEMO_LIMIT_REACHED" }]);
    expect((await User.findById(id)).demoAnalysesUsed).toBe(2);
    expect(await Repo.countDocuments({ user: id })).toBe(2);
    const me = await request(app).get(`${API}/users/me`).set(headers);
    expect(me.body.data.demo.analysesUsed).toBe(2);
  });

  it("marks guest repos and queues them behind real users' jobs", async () => {
    const { headers, id } = await startDemo();
    await analyse(headers, "one");

    const repo = await Repo.findOne({ user: id });
    expect(repo.ownerIsDemo).toBe(true);
    expect((await Job.findOne({ repo: repo._id })).priority).toBe(1);

    // a real user's later job still runs first
    const real = await User.create({
      username: "alice",
      email: "alice@example.test",
      password: "password123",
    });
    await request(app)
      .post(`${API}/repository/analyse`)
      .set(bearer(real.generateAccessToken()))
      .send({ url: "https://github.com/someone/real" });
    const realRepo = await Repo.findOne({ user: real._id });
    const claimed = await claimNextJob();
    expect(String(claimed.repo)).toBe(String(realRepo._id));
  });

  it("does not charge for re-submitting the same URL", async () => {
    const { headers, id } = await startDemo();
    expect((await analyse(headers, "one")).status).toBe(201);
    const again = await analyse(headers, "one");

    expect(again.status).toBe(200);
    expect((await User.findById(id)).demoAnalysesUsed).toBe(1);
    expect(await Job.countDocuments({ active: true })).toBe(1);
  });

  it("charges once for two simultaneous submits", async () => {
    const { headers, id } = await startDemo();
    const [a, b] = await Promise.all([
      analyse(headers, "one"),
      analyse(headers, "one"),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect((await User.findById(id)).demoAnalysesUsed).toBe(1);
  });

  it("does not charge when the URL is bad or the repo is missing", async () => {
    const { headers, id } = await startDemo();
    const bad = await request(app)
      .post(`${API}/repository/analyse`)
      .set(headers)
      .send({ url: "not a url" });
    expect(bad.status).toBe(400);

    octokitMock.repos.get.mockRejectedValueOnce({ status: 404 });
    const missing = await analyse(headers, "ghost");
    expect(missing.status).toBe(404);

    expect((await User.findById(id)).demoAnalysesUsed).toBe(0);
  });

  it("rejects private and oversize repos without charging", async () => {
    const { headers, id } = await startDemo();
    octokitMock.repos.get.mockResolvedValueOnce({
      data: { name: "p", private: true, size: 1 },
    });
    const priv = await analyse(headers, "p");
    expect(priv.status).toBe(400);
    expect(priv.body.errors).toEqual([{ code: "DEMO_REPO_NOT_ALLOWED" }]);

    octokitMock.repos.get.mockResolvedValueOnce({
      data: { name: "big", private: false, size: 999_999 },
    });
    const big = await analyse(headers, "big");
    expect(big.status).toBe(400);
    expect(big.body.errors).toEqual([{ code: "DEMO_REPO_TOO_LARGE" }]);

    expect((await User.findById(id)).demoAnalysesUsed).toBe(0);
  });

  it("refunds when starting the analysis fails", async () => {
    const { headers, id } = await startDemo();
    const spy = vi
      .spyOn(Repo, "create")
      .mockRejectedValueOnce(new Error("db down"));
    const res = await analyse(headers, "one");
    spy.mockRestore();

    expect(res.status).toBe(500);
    expect((await User.findById(id)).demoAnalysesUsed).toBe(0);
  });
});

describe("chat quota", () => {
  it("allows DEMO_CHAT_MAX messages, then 429 DEMO_CHAT_LIMIT_REACHED", async () => {
    const { headers, id } = await startDemo();
    const repo = await Repo.create({
      name: "mine",
      owner: "someone",
      url: "https://github.com/someone/mine",
      user: id,
      ownerIsDemo: true,
    });
    const ask = () =>
      request(app)
        .post(`${API}/aiChat/chat/${repo._id}`)
        .set(headers)
        .send({ question: "How does login work in this project?" });

    expect((await ask()).status).toBe(200);
    expect((await ask()).status).toBe(200);
    const third = await ask();

    expect(third.status).toBe(429);
    expect(third.body.errors).toEqual([{ code: "DEMO_CHAT_LIMIT_REACHED" }]);
    expect((await User.findById(id)).demoChatCount).toBe(2);
  });

  it("gives the message back when the request fails before an answer", async () => {
    const { headers, id } = await startDemo();
    const repo = await Repo.create({
      name: "mine",
      owner: "someone",
      url: "https://github.com/someone/mine",
      user: id,
    });
    const res = await request(app)
      .post(`${API}/aiChat/chat/${repo._id}`)
      .set(headers)
      .send({ question: "" });
    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 50)); // refund runs on 'finish'
    expect((await User.findById(id)).demoChatCount).toBe(0);
  });
});

describe("sample repos", () => {
  it("lists only ready samples", async () => {
    await sampleRepo();
    await Repo.create({
      name: "half",
      owner: "x",
      url: "https://github.com/x/half",
      user: (await User.findOne())._id,
      isSample: true,
      embeddingStatus: "processing",
    });
    const { headers } = await startDemo();

    const res = await request(app).get(`${API}/repository/samples`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      name: "sample",
      owner: "someone",
      language: "JavaScript",
    });
    expect(res.body.data[0].repoId).toBeTruthy();
  });

  it("requires login", async () => {
    const res = await request(app).get(`${API}/repository/samples`);
    expect(res.status).toBe(401);
  });

  it("lets a guest read a sample but not someone else's repo", async () => {
    const sample = await sampleRepo();
    const stranger = await User.create({
      username: "bob",
      email: "bob@example.test",
      password: "password123",
    });
    const private_ = await Repo.create({
      name: "secret",
      owner: "bob",
      url: "https://github.com/bob/secret",
      user: stranger._id,
    });
    const { headers } = await startDemo();

    const ok = await request(app)
      .get(`${API}/repository/getRepoInfo/${sample._id}?info=basicAnalysis`)
      .set(headers);
    expect(ok.status).toBe(200);
    expect(ok.body.data.basicInfo.name).toBe("sample");

    const hidden = await request(app)
      .get(`${API}/repository/getRepoInfo/${private_._id}`)
      .set(headers);
    expect(hidden.status).toBe(404);
  });

  it("keeps each guest's chat on a sample private, and never writes to the sample", async () => {
    const sample = await sampleRepo();
    const g1 = await startDemo();
    const g2 = await startDemo();
    const chat = (headers, question) =>
      request(app)
        .post(`${API}/aiChat/chat/${sample._id}`)
        .set(headers)
        .send({ question });

    expect((await chat(g1.headers, "How does login work here?")).status).toBe(200);
    llm.askLLM.mockResolvedValue("second");
    expect((await chat(g2.headers, "Where is the router defined?")).status).toBe(
      200
    );

    const h1 = await request(app)
      .get(`${API}/aiChat/chat-history/${sample._id}`)
      .set(g1.headers);
    expect(h1.body.data.messages.map((m) => m.content)).toEqual([
      "How does login work here?",
      "an answer",
    ]);
    const h2 = await request(app)
      .get(`${API}/aiChat/chat-history/${sample._id}`)
      .set(g2.headers);
    expect(h2.body.data.messages.map((m) => m.content)).toEqual([
      "Where is the router defined?",
      "second",
    ]);

    expect(await Chat.countDocuments({ repo: sample._id })).toBe(2);
    expect(await ChatMessage.countDocuments({ repo: sample._id, user: g1.id })).toBe(2);
    // the guest's own history now lists the sample, with only their preview
    const history = await request(app)
      .get(`${API}/users/repo-history`)
      .set(g1.headers);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0].messagePreview.content).toBe("an answer");
    const history2 = await request(app)
      .get(`${API}/users/repo-history`)
      .set(g2.headers);
    expect(history2.body.data[0].messagePreview.content).toBe("second");
  });

  it("does not show a sample in the history of a guest who never opened it", async () => {
    await sampleRepo();
    const { headers } = await startDemo();
    const res = await request(app).get(`${API}/users/repo-history`).set(headers);
    expect(res.body.data).toEqual([]);
  });
});

describe("deleting guest data", () => {
  async function guestWithData() {
    const g = await startDemo();
    const repo = await Repo.create({
      name: "mine",
      owner: "someone",
      url: "https://github.com/someone/mine",
      user: g.id,
      ownerIsDemo: true,
    });
    await File.create({ repo: repo._id, path: "a.js", type: "file" });
    await Embedding.create({ repo: repo._id, vector: [1, 2] });
    await Job.create({ repo: repo._id, payload: { owner: "s", name: "m" } });
    await ChatMessage.create({ repo: repo._id, role: "user", content: "hi" });
    await Chat.create({ repo: repo._id });
    return { ...g, repo };
  }

  it("logout ('End demo') deletes the guest and everything it owns, but not samples", async () => {
    const sample = await sampleRepo();
    const g = await guestWithData();
    await request(app)
      .post(`${API}/aiChat/chat/${sample._id}`)
      .set(g.headers)
      .send({ question: "How does login work here?" });

    const res = await request(app).post(`${API}/users/logout`).set(g.headers);
    expect(res.status).toBe(200);

    expect(await User.findById(g.id)).toBeNull();
    for (const model of [Repo, File, Embedding, Job, ChatMessage, Chat]) {
      expect(
        await model.countDocuments(model === Repo ? { user: g.id } : { repo: g.repo._id })
      ).toBe(0);
    }
    // the guest's chat on the sample is gone; the sample itself is untouched
    expect(await ChatMessage.countDocuments({ user: g.id })).toBe(0);
    expect(await Chat.countDocuments({ user: g.id })).toBe(0);
    expect(await Repo.findById(sample._id)).not.toBeNull();
    // the session is over
    expect((await request(app).get(`${API}/users/me`).set(g.headers)).status).toBe(
      401
    );
  });

  it("sweepExpiredDemo removes expired guests only", async () => {
    const expired = await guestWithData();
    const alive = await guestWithData();
    const real = await User.create({
      username: "alice",
      email: "alice@example.test",
      password: "password123",
    });
    await User.updateOne(
      { _id: expired.id },
      { expiresAt: new Date(Date.now() - 1000) }
    );

    const result = await sweepExpiredDemo();

    expect(result.users).toBe(1);
    expect(await User.findById(expired.id)).toBeNull();
    expect(await Repo.countDocuments({ user: expired.id })).toBe(0);
    expect(await User.findById(alive.id)).not.toBeNull();
    expect(await Repo.countDocuments({ user: alive.id })).toBe(1);
    expect(await User.findById(real._id)).not.toBeNull();
  });

  it("sweeps repos left behind by a guest that no longer exists", async () => {
    const g = await guestWithData();
    await User.deleteOne({ _id: g.id }); // e.g. a crash between the two deletes

    const result = await sweepExpiredDemo();

    expect(result.orphans).toBe(1);
    expect(await Repo.countDocuments({ _id: g.repo._id })).toBe(0);
    expect(await Embedding.countDocuments({ repo: g.repo._id })).toBe(0);
  });

  it("deleteDemoUser refuses to delete a real user", async () => {
    const real = await User.create({
      username: "alice",
      email: "alice@example.test",
      password: "password123",
    });
    expect(await deleteDemoUser(real._id)).toBe(false);
    expect(await User.findById(real._id)).not.toBeNull();
  });
});
