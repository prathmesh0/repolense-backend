import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";

// Own file: rate-limit counters live in memory for the whole test file.
describe("rate limiting", () => {
  it("blocks repeated login attempts with 429", async () => {
    const statuses = [];
    for (let i = 0; i < 22; i++) {
      const res = await request(app)
        .post("/api/v1/users/login")
        // invalid body: fails fast with 400 and needs no database
        .send({ email: { $ne: "" }, password: "x" });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });
});
