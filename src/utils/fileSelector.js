import { isSensitivePath, redactSecrets } from "./secrets.js";

// Files that say the most about a project, checked first
const PRIORITY_PATTERNS = [
  "README",
  "readme",
  "package.json",
  "pubspec.yaml",
  "requirements.txt",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "go.mod",
  "tsconfig.json",
  "next.config.js",
  "vite.config.js",
  "Dockerfile",
  "docker-compose.yml",
];

const DEFAULTS = {
  maxChars: 16000, // whole prompt body
  perFileChars: 4000, // one file never takes more than this
  maxTreeChars: 2500, // the file list at the top
  minSnippetChars: 200, // not worth adding a file with less room than this
};

const TRUNCATED = "\n[truncated]";

const depth = (path) => path.split("/").length;
const byDepthThenPath = (a, b) =>
  depth(a.path) - depth(b.path) || a.path.localeCompare(b.path);

const isReadable = (f) =>
  f.type !== "dir" &&
  typeof f.content === "string" &&
  f.content.trim() !== "" &&
  !isSensitivePath(f.path);

// A short list of every file path, so the model can judge the layout even
// for files whose content does not fit.
function buildTree(files, maxChars) {
  const paths = files
    .filter((f) => f.type !== "dir" && !isSensitivePath(f.path))
    .map((f) => f.path)
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));

  let text = `--- FILE TREE (${paths.length} files) ---\n`;
  let shown = 0;
  for (const path of paths) {
    if (text.length + path.length + 1 > maxChars) break;
    text += `${path}\n`;
    shown++;
  }
  if (shown < paths.length) text += `... and ${paths.length - shown} more\n`;
  return text;
}

// Builds the repository text sent to the LLM for the AI analysis.
// Returns "" when no file has readable content, so the caller can fail the
// stage instead of asking the model to analyse nothing.
//
// A file that is too long is cut to fit instead of being skipped: a long
// README as the very first file used to use up the whole budget and leave
// the prompt empty.
export function selectImportantFiles(files, options = {}) {
  const opts = {
    ...DEFAULTS,
    ...(typeof options === "number" ? { maxChars: options } : options),
  };

  const readable = files.filter(isReadable);
  if (readable.length === 0) return "";

  const isImportant = (f) => PRIORITY_PATTERNS.some((p) => f.path.includes(p));
  // Important files first, then small source files; shallow paths before deep
  const important = readable.filter(isImportant).sort(byDepthThenPath);
  const rest = readable
    .filter((f) => !isImportant(f) && f.size < 20000)
    .sort(byDepthThenPath);

  let collected = `${buildTree(files, opts.maxTreeChars)}\n`;

  for (const f of [...important, ...rest]) {
    const header = `\n--- FILE: ${f.path} ---\n`;
    const room = opts.maxChars - collected.length - header.length - 1;
    if (room < opts.minSnippetChars) break;

    const body = redactSecrets(f.content);
    const limit = Math.min(opts.perFileChars, room);
    // the marker has to fit inside the budget too
    const text =
      body.length > limit
        ? `${body.slice(0, limit - TRUNCATED.length)}${TRUNCATED}`
        : body;

    collected += `${header}${text}\n`;
  }

  return collected;
}
