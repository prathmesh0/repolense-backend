export function selectImportantFiles(files, maxChars = 8000) {
  // Priority Order
  const priorityPatterns = [
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

  // 1. Pick important files first
  const important = files.filter((f) =>
    priorityPatterns.some((p) => f.path.includes(p))
  );

  // 2. Add small source files if space left
  const rest = files.filter((f) => !important.includes(f) && f.size < 20000);

  // Merge with cutoff
  let collected = "";
  for (const f of [...important, ...rest]) {
    if (!f.content) continue;

    const snippet = `\n--- FILE: ${f.path} ---\n${f.content}\n`;
    if (collected.length + snippet.length > maxChars) break;

    collected += snippet;
  }

  return collected;
}
