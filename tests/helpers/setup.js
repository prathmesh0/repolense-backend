// Runs before every test file. Dummy secrets only.
process.env.NODE_ENV = "test";
process.env.ACCESS_TOKEN_SECRET = "test-access-secret";
process.env.ACCESS_TOKEN_EXPIRY = "1h";
process.env.REFRESH_TOKEN_SECRET = "test-refresh-secret";
process.env.REFRESH_TOKEN_EXPIRY = "1d";
process.env.GROQ_API_KEY = "test-key";
process.env.CORS_ORIGIN = "https://app.example.test";
process.env.LOG_LEVEL = "silent";
