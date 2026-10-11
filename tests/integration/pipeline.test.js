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

// GitHub is mocked, so these tests are deterministic and need no network.
const octokitMock = vi.hoisted(() => ({
  repos: { get: vi.fn() },
  git: { getTree: vi.fn(), getBlob: vi.fn() },
}));
vi.mock("../../src/services/github.client.js", () => ({
  octokit: octokitMock,
}));

import { Repo } from "../../src/models/repo.model.js";
import { File } from "../../src/models/file.model.js";
import { Embedding } from "../../src/models/embedding.model.js";
import { runAnalysisPipeline } from "../../src/services/analysisPipeline.service.js";
import { extractFileStructureInternal } from "../../src/services/fileStructure.service.js";
import { generateEmbeddingsForRepo } from "../../src/services/embed.service.js";
import { sweepStuckRepos } from "../../src/services/repoStatus.service.js";
import { clearTestDb, startTestDb, stopTestDb } from "../helpers/db.js";

const userId = new mongoose.Types.ObjectId();
const makeRepo = (over = {}) =>
  Repo.create({
    name: "demo",
    owner: "someone",
    url: `https://github.com/someone/demo-${Math.random()}`,
    user: userId,
    ...over,
  });

const b64 = (text) => Buffer.from(text).toString("base64");

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(async () => {
  await clearTestDb();
  vi.clearAllMocks();
});

describe("file extraction", () => {
  it("fetches the tree once, stores only indexable files, keeps secrets out", async () => {
    octokitMock.repos.get.mockResolvedValue({
      data: { default_branch: "main" },
    });
    octokitMock.git.getTree.mockResolvedValue({
      data: {
        truncated: false,
        tree: [
          { path: "src", type: "tree" },
          { path: "src/app.js", type: "blob", size: 40, sha: "sha-app" },
          { path: "README.md", type: "blob", size: 10, sha: "sha-readme" },
          { path: ".env", type: "blob", size: 20, sha: "sha-env" },
          {
            path: "package-lock.json",
            type: "blob",
            size: 99,
            sha: "sha-lock",
          },
          { path: "logo.png", type: "blob", size: 500, sha: "sha-png" },
          { path: "huge.js", type: "blob", size: 5_000_000, sha: "sha-huge" },
        ],
      },
    });
    octokitMock.git.getBlob.mockImplementation(async ({ file_sha }) => ({
      data: {
        content: b64(
          file_sha === "sha-app"
            ? `const k = "ghp_${"a".repeat(36)}";`
            : "# readme"
        ),
      },
    }));

    const repo = await makeRepo();
    const ok = await extractFileStructureInternal(repo._id, "someone", "demo");

    expect(ok).toBe(true);
    expect(octokitMock.git.getTree).toHaveBeenCalledTimes(1);

    const stored = await File.find({ repo: repo._id }).lean();
    expect(stored.map((f) => f.path).sort()).toEqual([
      "README.md",
      "src/app.js",
    ]);
    // downloaded only what it needed
    expect(octokitMock.git.getBlob).toHaveBeenCalledTimes(2);
    // key inside a normal file is redacted before storage
    const app = stored.find((f) => f.path === "src/app.js");
    expect(app.content).toContain("[REDACTED]");
    expect(app.content).not.toContain("ghp_");

    // the full tree (including skipped files) is still saved for the UI
    const saved = await Repo.findById(repo._id).lean();
    expect(saved.fileStructureStatus).toBe("ready");
    const names = JSON.stringify(saved.fileStructure);
    expect(names).toContain(".env");
    expect(names).toContain("logo.png");
    expect(saved.progress.fileStructure).toEqual({ done: 2, total: 2 });
  });

  it("skips a file that fails to download instead of failing the repo", async () => {
    octokitMock.repos.get.mockResolvedValue({
      data: { default_branch: "main" },
    });
    octokitMock.git.getTree.mockResolvedValue({
      data: {
        tree: [
          { path: "a.js", type: "blob", size: 5, sha: "ok" },
          { path: "b.js", type: "blob", size: 5, sha: "bad" },
        ],
      },
    });
    octokitMock.git.getBlob.mockImplementation(async ({ file_sha }) => {
      if (file_sha === "bad") throw new Error("boom");
      return { data: { content: b64("x") } };
    });

    const repo = await makeRepo();
    expect(await extractFileStructureInternal(repo._id, "o", "r")).toBe(true);
    expect(await File.countDocuments({ repo: repo._id })).toBe(1);
  });

  it("replaces files on re-analysis instead of duplicating them", async () => {
    octokitMock.repos.get.mockResolvedValue({
      data: { default_branch: "main" },
    });
    octokitMock.git.getTree.mockResolvedValue({
      data: {
        tree: [{ path: "a.js", type: "blob", size: 5, sha: "s" }],
      },
    });
    octokitMock.git.getBlob.mockResolvedValue({ data: { content: b64("x") } });

    const repo = await makeRepo();
    await extractFileStructureInternal(repo._id, "o", "r");
    await extractFileStructureInternal(repo._id, "o", "r");
    expect(await File.countDocuments({ repo: repo._id })).toBe(1);
  });
});

describe("pipeline failure handling", () => {
  it("fails all stages with clear reasons when extraction fails, and runs nothing else", async () => {
    octokitMock.repos.get.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const repo = await makeRepo({
      fileStructureStatus: "processing",
      aiStatus: "processing",
      embeddingStatus: "processing",
    });
    await runAnalysisPipeline(repo._id, "someone", "missing");

    const saved = await Repo.findById(repo._id).lean();
    expect(saved.fileStructureStatus).toBe("failed");
    expect(saved.aiStatus).toBe("failed");
    expect(saved.embeddingStatus).toBe("failed");
    expect(saved.statusErrors.fileStructure).toMatch(/not found/i);
    expect(saved.statusErrors.ai).toMatch(/skipped/i);
    expect(saved.statusErrors.embedding).toMatch(/skipped/i);
    // embedding never ran, so no metadata-only "ready" state
    expect(await Embedding.countDocuments({ repo: repo._id })).toBe(0);
  });
});

describe("embedding", () => {
  it("embeds indexable files only, tracks progress, and does not duplicate on re-run", async () => {
    const repo = await makeRepo({ embeddingStatus: "processing" });
    const code = "export const add = (a, b) => a + b;\n".repeat(60);
    await File.insertMany([
      { repo: repo._id, path: "src/a.js", type: "file", content: code },
      { repo: repo._id, path: ".env", type: "file", content: "TOKEN=abc" },
      { repo: repo._id, path: "yarn.lock", type: "file", content: "lock" },
    ]);

    await generateEmbeddingsForRepo(repo._id);
    const saved = await Repo.findById(repo._id).lean();
    expect(saved.embeddingStatus).toBe("ready");
    expect(saved.progress.embedding.done).toBe(saved.progress.embedding.total);

    const paths = new Set(
      (await Embedding.find({ repo: repo._id }).lean()).map((e) => e.path)
    );
    expect(paths.has("src/a.js")).toBe(true);
    expect(paths.has("REPO_METADATA")).toBe(true);
    expect(paths.has(".env")).toBe(false);
    expect(paths.has("yarn.lock")).toBe(false);

    const first = await Embedding.countDocuments({ repo: repo._id });
    await generateEmbeddingsForRepo(repo._id);
    expect(await Embedding.countDocuments({ repo: repo._id })).toBe(first);
  });
});

describe("stuck-repo sweep", () => {
  it("fails every stuck stage of stale repos and leaves fresh runs alone", async () => {
    const stale = await makeRepo({
      fileStructureStatus: "ready",
      aiStatus: "processing",
      embeddingStatus: "processing",
    });
    const fresh = await makeRepo({
      fileStructureStatus: "processing",
      aiStatus: "processing",
      embeddingStatus: "processing",
    });
    await Repo.collection.updateOne(
      { _id: stale._id },
      { $set: { updatedAt: new Date(Date.now() - 20 * 60 * 1000) } }
    );

    await sweepStuckRepos(15 * 60 * 1000);

    const s = await Repo.findById(stale._id).lean();
    expect(s.fileStructureStatus).toBe("ready");
    expect(s.aiStatus).toBe("failed");
    expect(s.embeddingStatus).toBe("failed");
    expect(s.statusErrors.ai).toMatch(/interrupted/i);

    const f = await Repo.findById(fresh._id).lean();
    expect([f.fileStructureStatus, f.aiStatus, f.embeddingStatus]).toEqual([
      "processing",
      "processing",
      "processing",
    ]);
  });
});
