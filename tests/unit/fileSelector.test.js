import { describe, expect, it } from "vitest";
import { selectImportantFiles } from "../../src/utils/fileSelector.js";

const file = (path, content, extra = {}) => ({
  path,
  type: "file",
  size: content?.length ?? 0,
  content,
  ...extra,
});

describe("selectImportantFiles", () => {
  it("does not return nothing when the first file is longer than the budget", () => {
    // This used to come back as "" (the README alone exceeded 8000 chars)
    const files = [
      file("README.md", "r".repeat(30000)),
      file("src/index.js", "export const answer = 42;"),
    ];

    const text = selectImportantFiles(files);

    expect(text).toContain("--- FILE: README.md ---");
    expect(text).toContain("[truncated]");
    expect(text).toContain("export const answer = 42;");
  });

  it("keeps the result inside the budget", () => {
    const files = Array.from({ length: 60 }, (_, i) =>
      file(`src/file${i}.js`, "x".repeat(3000))
    );
    expect(selectImportantFiles(files).length).toBeLessThanOrEqual(16000);
    expect(selectImportantFiles(files, 5000).length).toBeLessThanOrEqual(5000);
  });

  it("puts important files first and starts with a file tree", () => {
    const files = [
      file("src/a.js", "const a = 1;"),
      file("package.json", '{"name":"demo"}'),
    ];
    const text = selectImportantFiles(files);

    expect(text.startsWith("--- FILE TREE (2 files) ---")).toBe(true);
    expect(text.indexOf("FILE: package.json")).toBeLessThan(
      text.indexOf("FILE: src/a.js")
    );
  });

  it("lists files whose content does not fit, but never sensitive ones", () => {
    const files = [
      file("README.md", "hello"),
      file(".env", "SECRET=1"),
      file("dir", undefined, { type: "dir" }),
    ];
    const text = selectImportantFiles(files);

    expect(text).toContain("README.md");
    expect(text).not.toContain(".env");
    expect(text).not.toContain("SECRET=1");
  });

  it("returns an empty string when nothing is readable", () => {
    expect(selectImportantFiles([])).toBe("");
    expect(
      selectImportantFiles([
        file("empty.js", ""),
        file("blank.js", "   \n"),
        file(".env", "SECRET=1"),
        file("src", undefined, { type: "dir" }),
      ])
    ).toBe("");
  });
});
