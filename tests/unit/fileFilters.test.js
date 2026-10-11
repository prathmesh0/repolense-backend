import { describe, expect, it } from "vitest";
import { shouldIndexFile } from "../../src/utils/fileFilters.js";

describe("shouldIndexFile", () => {
  it("indexes source files and important root files", () => {
    expect(shouldIndexFile("src/app.js")).toBe(true);
    expect(shouldIndexFile("README.md")).toBe(true);
    expect(shouldIndexFile("Dockerfile")).toBe(true);
  });

  it("skips credential files, even at the root", () => {
    expect(shouldIndexFile(".env")).toBe(false);
    expect(shouldIndexFile("deploy/server.pem")).toBe(false);
  });

  it("skips lockfiles at any depth", () => {
    expect(shouldIndexFile("package-lock.json")).toBe(false);
    expect(shouldIndexFile("apps/web/yarn.lock")).toBe(false);
    expect(shouldIndexFile("go.sum")).toBe(false);
  });

  it("skips ignored folders, binaries and unknown types", () => {
    expect(shouldIndexFile("node_modules/x/index.js")).toBe(false);
    expect(shouldIndexFile("model/weights.pkl")).toBe(false);
    expect(shouldIndexFile("assets/logo.png")).toBe(false);
  });
});
