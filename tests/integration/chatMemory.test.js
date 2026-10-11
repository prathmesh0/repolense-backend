import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  askLLM: vi.fn(),
  askLLMStream: vi.fn(),
  embedText: vi.fn(),
  findSimilarChunks: vi.fn(),
}));
vi.mock("../../src/services/llm.service.js", () => ({
  askLLM: mocks.askLLM,
  askLLMStream: mocks.askLLMStream,
}));
vi.mock("../../src/services/embeddingModel.js", () => ({
  embedText: mocks.embedText,
}));
vi.mock("../../src/services/retrieval.service.js", () => ({
  findSimilarChunks: mocks.findSimilarChunks,
}));

import { app } from "../../src/app.js";
import { Chat } from "../../src/models/chat.model.js";
import { Repo } from "../../src/models/repo.model.js";
import { User } from "../../src/models/user.model.js";
import { clearTestDb, startTestDb, stopTestDb } from "../helpers/db.js";

const API = "/api/v1/aiChat";

async function setup() {
  const user = await User.create({
    username: "alice",
    email: "alice@example.test",
    password: "password123",
  });
  const repo = await Repo.create({
    name: "demo",
    owner: "someone",
    url: "https://github.com/someone/demo",
    user: user._id,
  });
  return {
    repo,
    headers: { Authorization: `Bearer ${user.generateAccessToken()}` },
  };
}

// supertest: collect the whole text/event-stream body
const sseParser = (res, cb) => {
  let text = "";
  res.on("data", (c) => (text += c));
  res.on("end", () => cb(null, text));
};
const parseSse = (text) =>
  text
    .trim()
    .split("\n\n")
    .map((block) => {
      const [event, data] = block.split("\n");
      return {
        event: event.replace("event: ", ""),
        data: JSON.parse(data.replace("data: ", "")),
      };
    });

async function* tokens(...parts) {
  for (const p of parts) yield p;
}

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(async () => {
  await clearTestDb();
  Object.values(mocks).forEach((m) => {
    m.mockReset();
  });
  mocks.embedText.mockResolvedValue([0.1, 0.2]);
  mocks.findSimilarChunks.mockResolvedValue([
    { path: "src/auth.js", contentPreview: "login code" },
  ]);
  mocks.askLLM.mockResolvedValue("first answer");
});

describe("chat memory", () => {
  it("sends earlier turns to the model, wrapped as untrusted, and keeps order", async () => {
    const { repo, headers } = await setup();

    await request(app)
      .post(`${API}/chat/${repo._id}`)
      .set(headers)
      .send({ question: "How does login work in this project?" });
    mocks.askLLM.mockResolvedValue("second answer");
    const res = await request(app)
      .post(`${API}/chat/${repo._id}`)
      .set(headers)
      .send({ question: "explain more" });

    expect(res.status).toBe(200);
    expect(mocks.askLLM.mock.calls[0][0].history).toEqual([]);
    expect(mocks.askLLM.mock.calls[1][0].history).toEqual([
      {
        role: "user",
        content:
          "<user_question>\nHow does login work in this project?\n</user_question>",
      },
      { role: "assistant", content: "first answer" },
    ]);

    const chat = await Chat.findOne({ repo: repo._id }).lean();
    expect(chat.messages.map((m) => m.content)).toEqual([
      "How does login work in this project?",
      "first answer",
      "explain more",
      "second answer",
    ]);
  });

  it("uses the previous question to search when the follow-up is short", async () => {
    const { repo, headers } = await setup();
    await request(app)
      .post(`${API}/chat/${repo._id}`)
      .set(headers)
      .send({ question: "How does login work in this project?" });
    await request(app)
      .post(`${API}/chat/${repo._id}`)
      .set(headers)
      .send({ question: "explain more" });

    expect(mocks.embedText.mock.calls[0][0]).toBe(
      "How does login work in this project?"
    );
    expect(mocks.embedText.mock.calls[1][0]).toBe(
      "How does login work in this project?\nexplain more"
    );
  });

  it("only sends the most recent turns", async () => {
    const { repo, headers } = await setup();
    await Chat.create({
      repo: repo._id,
      messages: Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: `m${i}`,
      })),
    });

    await request(app)
      .post(`${API}/chat/${repo._id}`)
      .set(headers)
      .send({ question: "a fresh and fairly long question about routing here" });

    const history = mocks.askLLM.mock.calls[0][0].history;
    expect(history).toHaveLength(6);
    expect(history.at(-1).content).toBe("m19");
  });
});

describe("streaming chat", () => {
  const post = (repo, headers, question = "How does login work?") =>
    request(app)
      .post(`${API}/chat/${repo._id}?stream=true`)
      .set(headers)
      .send({ question })
      .buffer(true)
      .parse(sseParser);

  it("streams sources, tokens and done, then saves the full answer", async () => {
    const { repo, headers } = await setup();
    mocks.askLLMStream.mockImplementation(() => tokens("Hel", "lo ", "there"));

    const res = await post(repo, headers);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const events = parseSse(res.body);
    expect(events.map((e) => e.event)).toEqual([
      "sources",
      "token",
      "token",
      "token",
      "done",
    ]);
    expect(events[0].data.sources).toEqual(["src/auth.js"]);
    const streamed = events
      .filter((e) => e.event === "token")
      .map((e) => e.data.text)
      .join("");
    expect(streamed).toBe("Hello there");

    const chat = await Chat.findOne({ repo: repo._id }).lean();
    expect(chat.messages.map((m) => m.content)).toEqual([
      "How does login work?",
      "Hello there",
    ]);
    expect(String(chat._id)).toBe(events.at(-1).data.chatId);
  });

  it("answers greetings through the same stream without calling the model", async () => {
    const { repo, headers } = await setup();
    const res = await post(repo, headers, "hello");
    const events = parseSse(res.body);
    expect(events.map((e) => e.event)).toEqual(["sources", "token", "done"]);
    expect(mocks.askLLMStream).not.toHaveBeenCalled();
  });

  it("returns a normal JSON error when there is nothing to search yet", async () => {
    const { repo, headers } = await setup();
    mocks.findSimilarChunks.mockResolvedValue([]);

    const res = await request(app)
      .post(`${API}/chat/${repo._id}?stream=true`)
      .set(headers)
      .send({ question: "How does login work?" });

    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(await Chat.countDocuments({})).toBe(0);
  });

  it("reports a failure mid-stream as an error event and saves nothing", async () => {
    const { repo, headers } = await setup();
    mocks.askLLMStream.mockImplementation(async function* () {
      yield "partial";
      throw new Error("groq exploded with secret details");
    });

    const res = await post(repo, headers);
    const events = parseSse(res.body);

    expect(events.at(-1).event).toBe("error");
    expect(events.at(-1).data.message).not.toMatch(/groq|secret/i);
    expect(await Chat.countDocuments({})).toBe(0);
  });

  it("still enforces ownership", async () => {
    const { repo } = await setup();
    const bob = await User.create({
      username: "bob",
      email: "bob@example.test",
      password: "password123",
    });
    const res = await request(app)
      .post(`${API}/chat/${repo._id}?stream=true`)
      .set({ Authorization: `Bearer ${bob.generateAccessToken()}` })
      .send({ question: "How does login work?" });
    expect(res.status).toBe(404);
  });
});
