import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose from "mongoose";

const askLLM = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/llm.service.js", () => ({ askLLM }));

import { Analysis } from "../../src/models/analysis.model.js";
import { File } from "../../src/models/file.model.js";
import { Repo } from "../../src/models/repo.model.js";
import { analyzeRepoWithAIInternal } from "../../src/services/getBasicAIAnalysis.js";
import { clearTestDb, startTestDb, stopTestDb } from "../helpers/db.js";

const GOOD =
  '{"summary":"A demo app","architecture":"Monolith","complexity":"Low","potentialIssues":["no tests"]}';

const makeRepo = () =>
  Repo.create({
    name: "demo",
    owner: "someone",
    url: "https://github.com/someone/demo",
    user: new mongoose.Types.ObjectId(),
  });

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(async () => {
  await clearTestDb();
  askLLM.mockReset();
});

describe("AI analysis stage", () => {
  it("sends a long README to the model and stores the result", async () => {
    const repo = await makeRepo();
    await File.create([
      { repo: repo._id, path: "README.md", type: "file", content: "r".repeat(30000) },
      { repo: repo._id, path: "src/index.js", type: "file", content: "console.log(1)" },
    ]);
    askLLM.mockResolvedValue(GOOD);

    await analyzeRepoWithAIInternal(repo._id);

    const sent = askLLM.mock.calls[0][0].user;
    expect(sent).toContain("--- FILE: README.md ---");
    expect(sent).toContain("console.log(1)");
    const done = await Repo.findById(repo._id);
    expect(done.aiStatus).toBe("ready");
    expect((await Analysis.findOne({ repo: repo._id })).summary).toBe("A demo app");
  });

  it("fails the stage, without calling the model, when nothing is readable", async () => {
    const repo = await makeRepo();
    await File.create([
      { repo: repo._id, path: "src", type: "dir" },
      { repo: repo._id, path: "empty.js", type: "file", content: "" },
    ]);

    await analyzeRepoWithAIInternal(repo._id);

    expect(askLLM).not.toHaveBeenCalled();
    const done = await Repo.findById(repo._id);
    expect(done.aiStatus).toBe("failed");
    expect(done.statusErrors.ai).toBe(
      "No readable source files were found to analyse."
    );
    expect(await Analysis.countDocuments({ repo: repo._id })).toBe(0);
  });

  it("marks the stage failed (not ready) when the model reply is unusable", async () => {
    const repo = await makeRepo();
    await File.create({
      repo: repo._id,
      path: "README.md",
      type: "file",
      content: "hello",
    });
    askLLM.mockResolvedValue("I cannot do that");

    await analyzeRepoWithAIInternal(repo._id);

    const done = await Repo.findById(repo._id);
    expect(done.aiStatus).toBe("failed");
    expect(await Analysis.countDocuments({ repo: repo._id })).toBe(0);
  });
});
