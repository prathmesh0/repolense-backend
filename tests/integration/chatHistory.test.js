import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { app } from "../../src/app.js";
import { Chat } from "../../src/models/chat.model.js";
import { ChatMessage } from "../../src/models/chatMessage.model.js";
import { Job } from "../../src/models/job.model.js";
import { Repo } from "../../src/models/repo.model.js";
import { User } from "../../src/models/user.model.js";
import {
  appendMessages,
  isFakeMessage,
  migrateLegacyChat,
  purgeFakeMessages,
} from "../../src/services/chatHistory.service.js";
import { clearTestDb, startTestDb, stopTestDb } from "../helpers/db.js";

const API = "/api/v1";

async function setup(name = "alice") {
  const user = await User.create({
    username: name,
    email: `${name}@example.test`,
    password: "password123",
  });
  const repo = await Repo.create({
    name: "demo",
    owner: "someone",
    url: `https://github.com/someone/demo-${name}`,
    user: user._id,
  });
  await User.updateOne({ _id: user._id }, { repoHistory: [repo._id] });
  return {
    user,
    repo,
    headers: { Authorization: `Bearer ${user.generateAccessToken()}` },
  };
}

// An old-format chat document, written directly to the collection
const legacyChat = (repoId, count) =>
  Chat.collection.insertOne({
    repo: repoId,
    createdAt: new Date(),
    messages: Array.from({ length: count }, (_, i) => ({
      _id: new mongoose.Types.ObjectId(),
      role: i % 2 ? "assistant" : "user",
      content: `legacy ${i}`,
      createdAt: new Date(Date.now() - (count - i) * 1000),
    })),
  });

beforeAll(async () => {
  await startTestDb();
  await ChatMessage.init();
});
afterAll(stopTestDb);
beforeEach(clearTestDb);

describe("chat history storage", () => {
  it("appends in order and keeps the chat summary current", async () => {
    const { repo } = await setup();
    const chatId = await appendMessages(repo._id, [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
    const again = await appendMessages(repo._id, [
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ]);

    expect(String(again)).toBe(String(chatId));
    const rows = await ChatMessage.find({ repo: repo._id }).sort({ _id: 1 });
    expect(rows.map((m) => m.content)).toEqual(["q1", "a1", "q2", "a2"]);
    const chat = await Chat.findById(chatId).lean();
    expect(chat.messageCount).toBe(4);
    expect(chat.lastMessage).toEqual({ role: "assistant", content: "a2" });
    expect(chat.messages).toBeUndefined();
  });

  it("pages history backwards without losing or repeating messages", async () => {
    const { repo, headers } = await setup();
    for (let i = 0; i < 5; i++) {
      await appendMessages(repo._id, [
        { role: "user", content: `q${i}` },
        { role: "assistant", content: `a${i}` },
      ]);
    }

    const page1 = await request(app)
      .get(`${API}/aiChat/chat-history/${repo._id}?limit=4`)
      .set(headers);
    expect(page1.body.data.messages.map((m) => m.content)).toEqual([
      "q3",
      "a3",
      "q4",
      "a4",
    ]);
    expect(page1.body.data.hasMore).toBe(true);

    const cursor = page1.body.data.messages[0]._id;
    const page2 = await request(app)
      .get(`${API}/aiChat/chat-history/${repo._id}?limit=4&before=${cursor}`)
      .set(headers);
    expect(page2.body.data.messages.map((m) => m.content)).toEqual([
      "q1",
      "a1",
      "q2",
      "a2",
    ]);

    const all = await request(app)
      .get(`${API}/aiChat/chat-history/${repo._id}`)
      .set(headers);
    expect(all.body.data.messages).toHaveLength(10);
    expect(all.body.data.hasMore).toBe(false);

    const bad = await request(app)
      .get(`${API}/aiChat/chat-history/${repo._id}?before=nope`)
      .set(headers);
    expect(bad.status).toBe(400);
  });

  it("getRepoInfo no longer writes anything to the chat", async () => {
    const { repo, headers } = await setup();
    for (const info of ["basicAnalysis", "fileStructure", "aiAnalysis"]) {
      const res = await request(app)
        .get(`${API}/repository/getRepoInfo/${repo._id}?info=${info}`)
        .set(headers);
      expect(res.status).toBe(200);
    }
    const all = await request(app)
      .get(`${API}/repository/getRepoInfo/${repo._id}`)
      .set(headers);
    expect(all.status).toBe(200);
    expect(await ChatMessage.countDocuments({})).toBe(0);
    expect(await Chat.countDocuments({})).toBe(0);
  });
});

describe("migration of old chats", () => {
  it("history of an old-format chat is migrated on first read, ids kept", async () => {
    const { repo, headers } = await setup();
    const { insertedId } = await legacyChat(repo._id, 4);

    const res = await request(app)
      .get(`${API}/aiChat/chat-history/${repo._id}`)
      .set(headers);

    expect(res.body.data.messages.map((m) => m.content)).toEqual([
      "legacy 0",
      "legacy 1",
      "legacy 2",
      "legacy 3",
    ]);
    expect(res.body.data.chatId).toBe(String(insertedId));
    const raw = await Chat.collection.findOne({ _id: insertedId });
    expect(raw.messages).toBeUndefined();
    expect(raw.messageCount).toBe(4);
    expect(raw.lastMessage.content).toBe("legacy 3");
  });

  it("a new message on an old chat keeps the earlier ones", async () => {
    const { repo } = await setup();
    await legacyChat(repo._id, 2);
    await appendMessages(repo._id, [
      { role: "user", content: "new q" },
      { role: "assistant", content: "new a" },
    ]);
    const rows = await ChatMessage.find({ repo: repo._id }).sort({
      createdAt: 1,
    });
    expect(rows.map((m) => m.content)).toEqual([
      "legacy 0",
      "legacy 1",
      "new q",
      "new a",
    ]);
    expect(await Chat.countDocuments({ repo: repo._id })).toBe(1);
  });

  it("dry run changes nothing; applying twice does not duplicate", async () => {
    const { repo } = await setup();
    const { insertedId } = await legacyChat(repo._id, 3);
    const raw = () => Chat.collection.findOne({ _id: insertedId });

    expect(await migrateLegacyChat(await raw(), { apply: false })).toEqual({
      messages: 3,
    });
    expect(await ChatMessage.countDocuments({})).toBe(0);
    expect((await raw()).messages).toHaveLength(3);

    const before = await raw();
    await migrateLegacyChat(before);
    // simulate an interrupted run: messages copied, chat not yet updated
    await migrateLegacyChat(before);
    expect(await ChatMessage.countDocuments({})).toBe(3);
  });

  it("repo-history lists old and new chats with previews", async () => {
    const { user, repo, headers } = await setup();
    const other = await Repo.create({
      name: "second",
      owner: "someone",
      url: "https://github.com/someone/second",
      user: user._id,
    });
    await User.updateOne(
      { _id: user._id },
      { repoHistory: [repo._id, other._id] }
    );
    await legacyChat(repo._id, 2); // not migrated yet
    await appendMessages(other._id, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "x".repeat(2000) },
    ]);

    const res = await request(app)
      .get(`${API}/users/repo-history`)
      .set(headers);
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      res.body.data.map((r) => [r.repoName, r])
    );
    expect(byName.demo.messagePreview.content).toBe("legacy 1");
    expect(byName.second.messagePreview.content.length).toBeLessThan(2000);
    expect(byName.second.chatId).toBeTruthy();
  });
});

describe("GET /users/me", () => {
  it("returns the current user without secrets", async () => {
    const { headers } = await setup();
    const res = await request(app).get(`${API}/users/me`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      username: "alice",
      email: "alice@example.test",
    });
    expect(res.body.data.password).toBeUndefined();
    expect(res.body.data.refreshToken).toBeUndefined();
  });

  it("requires login", async () => {
    const res = await request(app).get(`${API}/users/me`);
    expect(res.status).toBe(401);
  });
});

describe("GET /repository/status-stream/:repoId", () => {
  const sseParser = (res, cb) => {
    let text = "";
    res.on("data", (c) => (text += c));
    res.on("end", () => cb(null, text));
  };
  const events = (text) =>
    text
      .split("\n\n")
      .filter((b) => b.startsWith("event:"))
      .map((b) => {
        const [e, d] = b.split("\n");
        return {
          event: e.replace("event: ", ""),
          data: JSON.parse(d.replace("data: ", "")),
        };
      });
  const open = (repo, headers) =>
    request(app)
      .get(`${API}/repository/status-stream/${repo._id}`)
      .set(headers)
      .buffer(true)
      .parse(sseParser);

  it("sends the final state and closes when nothing is running", async () => {
    const { repo, headers } = await setup();
    await Repo.updateOne(
      { _id: repo._id },
      {
        fileStructureStatus: "ready",
        aiStatus: "ready",
        embeddingStatus: "failed",
        statusErrors: { embedding: "boom" },
      }
    );

    const res = await open(repo, headers);

    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const list = events(res.body);
    expect(list.map((e) => e.event)).toEqual(["status", "done"]);
    expect(list[0].data.statuses.embeddingStatus).toBe("failed");
    expect(list[0].data.statusErrors.embedding).toBe("boom");
    expect(list[0].data.progress.percent).toBe(100);
  });

  it("pushes changes while a job is live, then finishes", async () => {
    process.env.STATUS_STREAM_POLL_MS = "50";
    const { repo, headers } = await setup();
    await Repo.updateOne(
      { _id: repo._id },
      { fileStructureStatus: "processing", aiStatus: "processing" }
    );
    await Job.create({
      repo: repo._id,
      payload: { owner: "o", name: "r" },
      status: "running",
    });

    const pending = open(repo, headers).then((r) => r); // supertest only sends once awaited or .then()ed
    await new Promise((r) => setTimeout(r, 250));
    await Repo.updateOne(
      { _id: repo._id },
      {
        "progress.fileStructure": { done: 5, total: 10 },
      }
    );
    await new Promise((r) => setTimeout(r, 250));
    await Repo.updateOne(
      { _id: repo._id },
      {
        fileStructureStatus: "ready",
        aiStatus: "ready",
        embeddingStatus: "ready",
      }
    );
    await Job.updateMany({}, { status: "done", active: false });

    const list = events((await pending).body);
    const statuses = list.filter((e) => e.event === "status");
    expect(statuses.length).toBeGreaterThanOrEqual(3);
    expect(statuses[0].data.finished).toBe(false);
    expect(statuses[0].data.job.status).toBe("running");
    expect(statuses.at(-1).data.finished).toBe(true);
    expect(list.at(-1).event).toBe("done");
    delete process.env.STATUS_STREAM_POLL_MS;
  });

  it("enforces ownership and login", async () => {
    const { repo } = await setup();
    const bob = await setup("bob");

    const foreign = await request(app)
      .get(`${API}/repository/status-stream/${repo._id}`)
      .set(bob.headers);
    expect(foreign.status).toBe(404);

    const anon = await request(app).get(
      `${API}/repository/status-stream/${repo._id}`
    );
    expect(anon.status).toBe(401);
  });
});

describe("purge of old fake messages", () => {
  it("removes label and dump messages, keeps real conversation, fixes the summary", async () => {
    const { repo } = await setup();
    await appendMessages(repo._id, [
      { role: "user", content: "How does login work?" },
      { role: "assistant", content: "It uses JWT." },
    ]);
    await appendMessages(repo._id, [
      { role: "user", content: "AI Analysis" },
      {
        role: "assistant",
        content: JSON.stringify({ aiAnalysis: { summary: "x" } }, null, 2),
      },
    ]);
    await appendMessages(repo._id, [
      { role: "user", content: "Get File Structure" },
      {
        role: "assistant",
        content:
          "File structure extraction is still in progress. Please check back shortly.",
      },
    ]);

    const dry = await purgeFakeMessages({ apply: false });
    expect(dry).toMatchObject({ scanned: 6, fake: 4, chats: 1 });
    expect(await ChatMessage.countDocuments({})).toBe(6);

    await purgeFakeMessages({ apply: true });
    const left = await ChatMessage.find({}).sort({ _id: 1 }).lean();
    expect(left.map((m) => m.content)).toEqual([
      "How does login work?",
      "It uses JWT.",
    ]);
    const chat = await Chat.findOne({ repo: repo._id }).lean();
    expect(chat.messageCount).toBe(2);
    expect(chat.lastMessage.content).toBe("It uses JWT.");
  });

  it("does not treat a real answer that mentions JSON as fake", () => {
    expect(
      isFakeMessage({ role: "assistant", content: 'The config is { "a": 1 }' })
    ).toBe(false);
    expect(
      isFakeMessage({ role: "user", content: "What is AI Analysis?" })
    ).toBe(false);
  });
});
