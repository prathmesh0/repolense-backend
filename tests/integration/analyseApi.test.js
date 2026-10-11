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

// GitHub is mocked: no network. The worker is not started, so jobs stay queued.
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

import { app } from "../../src/app.js";
import { Job } from "../../src/models/job.model.js";
import { Repo } from "../../src/models/repo.model.js";
import { User } from "../../src/models/user.model.js";
import { clearTestDb, startTestDb, stopTestDb } from "../helpers/db.js";

const API = "/api/v1";
const URL = "https://github.com/someone/demo";

async function login() {
  const user = await User.create({
    username: "alice",
    email: "alice@example.test",
    password: "password123",
  });
  return {
    user,
    headers: { Authorization: `Bearer ${user.generateAccessToken()}` },
  };
}

beforeAll(async () => {
  await startTestDb();
  await Job.init();
  await Repo.init();
});
afterAll(stopTestDb);
beforeEach(async () => {
  await clearTestDb();
  vi.clearAllMocks();
  octokitMock.repos.get.mockResolvedValue({
    data: {
      name: "demo",
      stargazers_count: 3,
      forks_count: 1,
      description: "d",
    },
  });
  octokitMock.repos.listBranches.mockResolvedValue({
    data: [{ name: "main" }],
  });
  octokitMock.repos.listContributors.mockResolvedValue({
    data: [{ login: "a" }],
  });
  octokitMock.repos.listLanguages.mockResolvedValue({
    data: { JavaScript: 10 },
  });
  octokitMock.repos.listCommits.mockResolvedValue({ headers: {}, data: [{}] });
});

describe("POST /repository/analyse", () => {
  it("creates the repo, queues one job, and answers 201 immediately", async () => {
    const { headers } = await login();

    const res = await request(app)
      .post(`${API}/repository/analyse`)
      .set(headers)
      .send({ url: URL });

    expect(res.status).toBe(201);
    expect(res.body.data.basicInfo.name).toBe("demo");
    expect(res.body.data.basicInfo.fileStructureStatus).toBe("processing");

    const jobs = await Job.find({}).lean();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: "queued",
      active: true,
      payload: { owner: "someone", name: "demo" },
    });
  });

  it("does not queue a second job while one is waiting or running", async () => {
    const { headers } = await login();

    await request(app)
      .post(`${API}/repository/analyse`)
      .set(headers)
      .send({ url: URL });
    const second = await request(app)
      .post(`${API}/repository/analyse`)
      .set(headers)
      .send({ url: URL });

    expect(second.status).toBe(200);
    expect(second.body.message).toMatch(/already in progress/i);
    expect(await Job.countDocuments({})).toBe(1);
  });

  it("queues again once the previous job has finished", async () => {
    const { headers } = await login();

    await request(app)
      .post(`${API}/repository/analyse`)
      .set(headers)
      .send({ url: URL });
    await Job.updateMany(
      {},
      { status: "done", active: false, finishedAt: new Date() }
    );

    const again = await request(app)
      .post(`${API}/repository/analyse`)
      .set(headers)
      .send({ url: URL });
    expect(again.status).toBe(201);
    expect(await Job.countDocuments({})).toBe(2);
  });

  it("rejects a bad url and an unauthenticated caller", async () => {
    const { headers } = await login();

    const bad = await request(app)
      .post(`${API}/repository/analyse`)
      .set(headers)
      .send({ url: { $ne: "" } });
    expect(bad.status).toBe(400);

    const anon = await request(app)
      .post(`${API}/repository/analyse`)
      .send({ url: URL });
    expect(anon.status).toBe(401);
    expect(await Job.countDocuments({})).toBe(0);
  });

  it("shows queue state in getRepoInfo", async () => {
    const { headers } = await login();
    const created = await request(app)
      .post(`${API}/repository/analyse`)
      .set(headers)
      .send({ url: URL });
    const repoId = created.body.data.basicInfo._id;

    const info = await request(app)
      .get(`${API}/repository/getRepoInfo/${repoId}?info=basicAnalysis`)
      .set(headers);

    expect(info.status).toBe(200);
    expect(info.body.data.job).toMatchObject({ status: "queued", position: 1 });
  });
});
