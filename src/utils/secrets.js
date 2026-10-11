import micromatch from "micromatch";

// Files that commonly hold credentials. Their content must never be stored,
// embedded, or sent to the LLM. ".env.example" style templates are allowed.
const SENSITIVE_PATH_PATTERNS = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/id_rsa*",
  "**/id_dsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  "**/.npmrc",
  "**/.pypirc",
  "**/.netrc",
  "**/.htpasswd",
  "**/credentials",
  "**/credentials.json",
  "**/secrets.*",
  "**/service-account*.json",
  "**/google-services.json",
  "**/GoogleService-Info.plist",
];

const ALLOWED_TEMPLATES = [
  "**/.env.example",
  "**/.env.sample",
  "**/.env.template",
];

const matchOpts = { dot: true, nocase: true };

export const isSensitivePath = (filePath) =>
  !micromatch.isMatch(filePath, ALLOWED_TEMPLATES, matchOpts) &&
  micromatch.isMatch(filePath, SENSITIVE_PATH_PATTERNS, matchOpts);

// Catches credentials pasted into otherwise normal files (README, config...)
const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g,
  /\bgsk_[A-Za-z0-9]{40,}\b/g, // Groq
  /\bsk-[A-Za-z0-9_-]{32,}\b/g, // OpenAI / Anthropic style
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /mongodb(?:\+srv)?:\/\/[^\s:@/]+:[^\s@/]+@/g, // DB URI with password
];

export const redactSecrets = (text) =>
  SECRET_CONTENT_PATTERNS.reduce(
    (out, re) => out.replace(re, "[REDACTED]"),
    text
  );
