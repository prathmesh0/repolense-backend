import { describe, expect, it } from "vitest";
import { isSensitivePath, redactSecrets } from "../../src/utils/secrets.js";

describe("isSensitivePath", () => {
  it.each([
    ".env",
    "server/.env.production",
    "keys/id_rsa",
    "certs/server.pem",
    "config/credentials.json",
    "secrets.yml",
  ])("flags %s", (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each([".env.example", "a/b/.env.sample", "src/app.js", "README.md"])(
    "allows %s",
    (path) => {
      expect(isSensitivePath(path)).toBe(false);
    }
  );
});

describe("redactSecrets", () => {
  it("redacts known key formats and DB passwords", () => {
    const input = [
      `token ghp_${"a".repeat(36)}`,
      "mongodb+srv://user:pw@cluster.example/db",
      "aws AKIAABCDEFGHIJKLMNOP",
    ].join("\n");
    const out = redactSecrets(input);
    expect(out).not.toMatch(/ghp_|AKIA|user:pw/);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts private key blocks", () => {
    const key =
      "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----";
    expect(redactSecrets(`before ${key} after`)).toBe(
      "before [REDACTED] after"
    );
  });

  it("leaves normal code unchanged", () => {
    const code = "export const add = (a, b) => a + b;";
    expect(redactSecrets(code)).toBe(code);
  });
});
