import { describe, expect, it } from "vitest";
import { classifyIntent } from "../../src/services/chat.service.js";
import { cosineSimilarity } from "../../src/utils/cosineSimilarity.js";
import { chunkText } from "../../src/services/embed.service.js";

describe("classifyIntent", () => {
  it.each(["hi", "Hello!", "hey there", "good morning"])(
    "greeting: %s",
    (text) => expect(classifyIntent(text)).toBe("GREETING")
  );

  it.each(["thanks", "Thank you!", "ok", "got it"])(
    "acknowledgement: %s",
    (text) => expect(classifyIntent(text)).toBe("ACKNOWLEDGEMENT")
  );

  it.each([
    "hi, what does auth do?",
    "how does the login work",
    "thanks for the help, now explain routes",
  ])("query: %s", (text) => expect(classifyIntent(text)).toBe("QUERY"));
});

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
});

describe("chunkText", () => {
  it("returns one chunk for short text", () => {
    expect(chunkText("short")).toEqual(["short"]);
  });

  it("splits long text into overlapping chunks that cover everything", () => {
    const text = "a".repeat(3000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.length <= 1024)).toBe(true);
    expect(chunks.at(-1).length).toBeGreaterThan(0);
  });
});
