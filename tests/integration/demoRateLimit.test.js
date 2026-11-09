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

// Read by the limiters the first time they are used
process.env.DEMO_LOGIN_PER_HOUR = "5";
process.env.DEMO_LOGIN_PER_DAY = "50";
process.env.DEMO_IP_DAILY_ANALYSES = "3";

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

beforeAll(async () => {
  await startTestDb();
  await Job.init();
  await Repo.init();
});
afterAll(stopTestDb);
beforeEach(async () => {
  await clearTestDb();
  octokitMock.repos.get.mockImplementation(async ({ repo }) => ({
    data: { name: repo, private: false, size: 10 },
  }));
  octokitMock.repos.listBranches.mockResolvedValue({ data: [] });
  octokitMock.repos.listContributors.mockResolvedValue({ data: [] });
  octokitMock.repos.listLanguages.mockResolvedValue({ data: {} });
  octokitMock.repos.listCommits.mockResolvedValue({ headers: {}, data: [] });
});

const guest = async () => {
  const res = await request(app).post(`${API}/users/demo-login`);
  return {
    res,
    id: res.body.data?.user?._id,
    headers: { Authorization: `Bearer ${res.body.data?.accessToken}` },
  };
};
const analyse = (headers, name) =>
  request(app)
    .post(`${API}/repository/analyse`)
    .set(headers)
    .send({ url: `https://github.com/someone/${name}` });

describe("demo rate limits (per IP)", () => {
  // Both tests share one IP and one in-memory counter, so budgets are
  // spent in order: 5 guest sessions per hour, 3 started analyses per day.
  it("caps analyses per IP across guests, and counts only started ones", async () => {
    const a = await guest();
    const b = await guest(); // 2 of 5 sessions used

    expect((await analyse(a.headers, "one")).status).toBe(201);
    expect((await analyse(a.headers, "two")).status).toBe(201);
    // a 200 (already analysed) or a 403 must not eat the IP budget
    expect((await analyse(a.headers, "one")).status).toBe(200);
    expect((await analyse(a.headers, "three")).status).toBe(403);
    expect((await analyse(b.headers, "four")).status).toBe(201); // 3rd started

    const blocked = await analyse(b.headers, "five");
    expect(blocked.status).toBe(429);
    expect(blocked.body.errors).toEqual([{ code: "DEMO_RATE_LIMITED" }]);
    expect((await User.findById(b.id)).demoAnalysesUsed).toBe(1);
  });

  it("allows 5 guest sessions per IP per hour, then 429", async () => {
    // 2 were used by the previous test
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await guest()).res.status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });
});
