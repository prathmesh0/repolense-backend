import { describe, expect, it } from "vitest";
import {
  computeProgress,
  userFacingError,
} from "../../src/services/repoStatus.service.js";

describe("computeProgress", () => {
  it("is 0 when nothing has started", () => {
    expect(computeProgress({}).percent).toBe(0);
  });

  it("is 100 when every stage is ready", () => {
    const repo = {
      fileStructureStatus: "ready",
      aiStatus: "ready",
      embeddingStatus: "ready",
    };
    expect(computeProgress(repo).percent).toBe(100);
  });

  it("counts failed stages as finished", () => {
    const repo = {
      fileStructureStatus: "failed",
      aiStatus: "failed",
      embeddingStatus: "failed",
    };
    expect(computeProgress(repo).percent).toBe(100);
  });

  it("uses embedding counters while processing", () => {
    const repo = {
      fileStructureStatus: "ready",
      aiStatus: "processing",
      embeddingStatus: "processing",
      progress: { embedding: { done: 5, total: 10 } },
    };
    expect(computeProgress(repo).percent).toBe(55);
  });
});

describe("userFacingError", () => {
  it("maps GitHub rate limits without leaking the raw message", () => {
    const error = {
      status: 403,
      message: "API rate limit exceeded for 1.2.3.4",
    };
    const text = userFacingError(error, "fallback");
    expect(text).toMatch(/rate limit/i);
    expect(text).not.toContain("1.2.3.4");
  });

  it("maps 404 and falls back for unknown errors", () => {
    expect(userFacingError({ status: 404 }, "x")).toMatch(/not found/i);
    expect(userFacingError(new Error("secret internals"), "generic")).toBe(
      "generic"
    );
  });
});
