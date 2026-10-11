import micromatch from "micromatch";
import { isSensitivePath } from "./secrets.js";
import {
  IMPORTANT_ROOT_FILES,
  IGNORED_PATHS,
  textExtensions,
} from "../constants.js";

// Extensions listed in textExtensions that are really binary blobs
const BINARY_EXTENSIONS = [".pkl", ".pt", ".h5", ".onnx", ".parquet", ".avro"];

export const MAX_FILE_BYTES = 200 * 1024;
export const MAX_FILES_TO_FETCH = 1500;

const hasTextExtension = (path) => {
  const lower = path.toLowerCase();
  if (BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext))) return false;
  return textExtensions.some((ext) => lower.endsWith(ext));
};

// Single source of truth: used both to decide what to download from GitHub
// and what to embed.
// Machine-generated dependency locks: huge, repetitive, and useless as chat context
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "bun.lockb",
  "composer.lock",
  "gemfile.lock",
  "poetry.lock",
  "pipfile.lock",
  "cargo.lock",
  "go.sum",
  "pubspec.lock",
]);

export function shouldIndexFile(
  filePath,
  fileName = filePath.split("/").pop()
) {
  // Never index credential files, even if they are "important" root files
  if (isSensitivePath(filePath)) return false;

  if (LOCKFILE_NAMES.has(fileName.toLowerCase())) return false;

  // Always index important root files located at root (no slashes)
  if (
    !filePath.includes("/") &&
    IMPORTANT_ROOT_FILES.some(
      (important) => important.toLowerCase() === fileName.toLowerCase()
    )
  ) {
    return true;
  }

  // Ignore files in ignored directories/patterns
  if (micromatch.isMatch(filePath, IGNORED_PATHS)) return false;

  // Finally, check if file extension is a recognized text/code type
  return hasTextExtension(fileName || filePath);
}
