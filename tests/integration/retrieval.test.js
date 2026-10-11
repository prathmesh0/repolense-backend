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
import { Embedding } from "../../src/models/embedding.model.js";
import {
  VECTOR_INDEX_NAME,
  findSimilarChunks,
  resetVectorSearchState,
} from "../../src/services/retrieval.service.js";
import { clearTestDb, startTestDb, stopTestDb } from "../helpers/db.js";

const repoA = new mongoose.Types.ObjectId();
const repoB = new mongoose.Types.ObjectId();

// Tiny 3-dimension vectors keep the ranking easy to reason about
const chunk = (repo, path, vector) => ({
  repo,
  path,
  chunkIndex: 0,
  vector,
  contentPreview: `content of ${path}`,
});

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(async () => {
  await clearTestDb();
  resetVectorSearchState();
  vi.restoreAllMocks();
});

async function seed() {
  await Embedding.insertMany([
    chunk(repoA, "best.js", [1, 0, 0]),
    chunk(repoA, "second.js", [0.9, 0.1, 0]),
    chunk(repoA, "third.js", [0.5, 0.5, 0]),
    chunk(repoA, "far.js", [0, 0, 1]),
    // closest of all, but belongs to another repository
    chunk(repoB, "other-repo.js", [1, 0, 0]),
  ]);
}

describe("in-memory fallback (no Atlas on this database)", () => {
  it("returns the best chunks of this repo only, best first", async () => {
    await seed();
    const result = await findSimilarChunks(repoA, [1, 0, 0], 3);

    expect(result.map((r) => r.path)).toEqual([
      "best.js",
      "second.js",
      "third.js",
    ]);
    expect(result[0].contentPreview).toBe("content of best.js");
    expect(result[0].score).toBeGreaterThan(result[1].score);
    expect(result.some((r) => r.path === "other-repo.js")).toBe(false);
    // the raw vector is not sent back to callers
    expect(result[0].vector).toBeUndefined();
  });

  it("returns an empty list for a repo with no embeddings", async () => {
    expect(await findSimilarChunks(repoA, [1, 0, 0], 5)).toEqual([]);
  });
});

describe("Atlas vector search", () => {
  it("builds a repo-filtered $vectorSearch and returns its rows", async () => {
    const rows = [
      { path: "a.js", chunkIndex: 0, contentPreview: "A", score: 0.99 },
      { path: "b.js", chunkIndex: 1, contentPreview: "B", score: 0.9 },
    ];
    const aggregate = vi.spyOn(Embedding, "aggregate").mockResolvedValue(rows);

    const result = await findSimilarChunks(repoA, [1, 0, 0], 5);

    expect(result).toBe(rows);
    const [pipeline] = aggregate.mock.calls[0];
    const stage = pipeline[0].$vectorSearch;
    expect(stage.index).toBe(VECTOR_INDEX_NAME);
    expect(stage.path).toBe("vector");
    expect(stage.queryVector).toEqual([1, 0, 0]);
    expect(stage.limit).toBe(5);
    expect(stage.numCandidates).toBeGreaterThanOrEqual(100);
    expect(String(stage.filter.repo)).toBe(String(repoA));
    expect(stage.filter.repo).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  it("falls back to in-memory search when Atlas returns nothing yet", async () => {
    await seed();
    vi.spyOn(Embedding, "aggregate").mockResolvedValue([]);

    const result = await findSimilarChunks(repoA, [1, 0, 0], 2);
    expect(result.map((r) => r.path)).toEqual(["best.js", "second.js"]);
  });

  it("falls back on an error, then skips Atlas for a while", async () => {
    await seed();
    const aggregate = vi
      .spyOn(Embedding, "aggregate")
      .mockRejectedValue(new Error("$vectorSearch is only allowed on Atlas"));

    const first = await findSimilarChunks(repoA, [1, 0, 0], 2);
    const second = await findSimilarChunks(repoA, [1, 0, 0], 2);

    expect(first.map((r) => r.path)).toEqual(["best.js", "second.js"]);
    expect(second.map((r) => r.path)).toEqual(["best.js", "second.js"]);
    // the failing call was not repeated for the second request
    expect(aggregate).toHaveBeenCalledTimes(1);
  });
});
