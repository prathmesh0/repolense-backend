export const DB_NAME = "repolense";

export const IGNORED_PATHS = [
  "node_modules/**",
  "build/**",
  "dist/**",
  "coverage/**",
  "android/**",
  "ios/**",
  "windows/**", // Flutter & native Windows build
  "linux/**", // Flutter & native Linux build
  "macos/**", // Flutter & native Mac build
  "web/**", // Flutter web build output
  ".git/**",
  ".github/**",
  "venv/**",
  "__pycache__/**",
  ".next/**",
  "out/**",
  "target/**",
  "tmp/**",
  ".dart_tool/**", // Dart/Flutter tool cache
  ".pub-cache/**", // Pub package cache
  ".flutter-plugins", // Flutter plugins config
  ".flutter-plugins-dependencies",
  ".packages", // Dart package config
  ".pnp/**", // Yarn PnP
  "bower_components/**",
  ".webpack/**",
  ".parcel-cache/**",
  ".nyc_output/**",
  ".rpt2_cache/**",
  ".eslintcache",
  ".stylelintcache",
  ".vscode-test/**",
  ".serverless/**",
  ".fusebox/**",
  ".dynamodb/**",
  ".cache/**",
  "Pods/**", // CocoaPods for iOS
  "DerivedData/**", // Xcode build intermediate
  ".externalNativeBuild/**", // Android native builds
  "**/gradle-wrapper.jar",
  "**/gradle-wrapper.properties",
  "**/gradle-wrapper.log",
];

export const IMPORTANT_ROOT_FILES = [
  "README.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "package.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "package-lock.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "Pipfile",
  "Pipfile.lock",
  "environment.yml",
  "go.mod",
  "go.sum",
  ".env",
  ".env.example",
  ".gitignore",
  "pubspec.yaml", // Flutter/Dart
  "analysis_options.yaml", // Dart analysis config
  "build.gradle",
  "gradle.properties",
  "settings.gradle",
  "gradlew",
  "gradlew.bat",
  "Dockerfile",
  "docker-compose.yml",
  "Jenkinsfile",
  ".circleci/", // CI config folder
  ".github/workflows/", // GitHub Actions
  ".gitlab-ci.yml",
  "webpack.config.js",
  "tsconfig.json",
  "angular.json",
  "nx.json",
  "lerna.json",
  "babel.config.js",
  "Makefile",
];

export const textExtensions = [
  // Core languages
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".ipynb",
  ".java",
  ".kt",
  ".kts",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".go",
  ".rs",
  ".swift",
  ".dart",

  // Web & UI
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".vue",
  ".svelte",

  // Backend / Server-side
  ".php",
  ".rb",
  ".rake",
  ".cs",
  ".asp",
  ".jsp",

  // Data & Config
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".env",
  ".xml",
  ".csv",
  ".tsv",

  // Documentation / Text
  ".md",
  ".markdown",
  ".txt",
  ".rst",
  ".tex",
  ".log",

  // Build / DevOps
  ".gradle",
  ".properties",
  ".sh",
  ".bash",
  ".bat",
  "Dockerfile",
  ".dockerignore",
  ".gitignore",
  ".gitattributes",

  // AI / ML Specific
  ".pkl",
  ".pt",
  ".h5",
  ".onnx",
  ".pbtxt",
  ".cfg",
  ".sql",
  ".parquet",
  ".avro",
];
