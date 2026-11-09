// Demo-mode settings, read from the environment on every call so tests and
// operators can change them without a restart of the module graph.
//
//   DEMO_ENABLED         "false" turns the whole demo off (default: on)
//   DEMO_TTL_MINUTES     guest session lifetime (default 60)
//   DEMO_MAX_ANALYSES    own-repo analyses per guest (default 2)
//   DEMO_CHAT_MAX        chat messages per guest (default 20)
//   DEMO_MAX_REPO_KB     largest repo a guest may analyse, GitHub size in KB (default 20000)
//   DEMO_IP_DAILY_ANALYSES  analyses per IP per day across guests (default 6)
//   DEMO_LOGIN_PER_HOUR / DEMO_LOGIN_PER_DAY  guest sessions per IP (default 5 / 20)
//   DEMO_CLEANUP_MINUTES how often expired guests are swept (default 10)

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const demoConfig = () => ({
  enabled: process.env.DEMO_ENABLED !== "false",
  ttlMinutes: int(process.env.DEMO_TTL_MINUTES, 60),
  maxAnalyses: int(process.env.DEMO_MAX_ANALYSES, 2),
  maxChats: int(process.env.DEMO_CHAT_MAX, 20),
  maxRepoKb: int(process.env.DEMO_MAX_REPO_KB, 20000),
  ipDailyAnalyses: int(process.env.DEMO_IP_DAILY_ANALYSES, 6),
  loginPerHour: int(process.env.DEMO_LOGIN_PER_HOUR, 5),
  loginPerDay: int(process.env.DEMO_LOGIN_PER_DAY, 20),
  cleanupMinutes: int(process.env.DEMO_CLEANUP_MINUTES, 10),
});

// Sample repos seeded by `npm run seed:samples`
export const DEFAULT_SAMPLE_REPOS = [
  "https://github.com/sindresorhus/is",
  "https://github.com/tj/commander.js",
  "https://github.com/expressjs/cors",
];

export const sampleRepoUrls = () => {
  const fromEnv = (process.env.SAMPLE_REPOS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_SAMPLE_REPOS;
};
