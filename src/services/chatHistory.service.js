import { Chat } from "../models/chat.model.js";
import { ChatMessage } from "../models/chatMessage.model.js";
import { logger } from "../utils/logger.js";

export const PREVIEW_MAX_CHARS = 500;
export const HISTORY_PAGE_DEFAULT = 500;
export const HISTORY_PAGE_MAX = 500;

const clipPreview = (text) =>
  text.length > PREVIEW_MAX_CHARS
    ? `${text.slice(0, PREVIEW_MAX_CHARS)}…`
    : text;

const summaryFields = (message, count) => ({
  lastMessage: { role: message.role, content: clipPreview(message.content) },
  lastMessageAt: message.createdAt ?? new Date(),
  messageCount: count,
});

// Moves one legacy chat document (messages array inside the Chat document)
// into the ChatMessage collection. Safe to run twice: message ids are kept
// and duplicates are ignored. `rawChat` must come from the raw collection
// or .lean(), because the schema no longer has `messages`.
export async function migrateLegacyChat(rawChat, { apply = true } = {}) {
  const legacy = rawChat.messages ?? [];
  if (!apply) return { messages: legacy.length };

  if (legacy.length) {
    try {
      await ChatMessage.insertMany(
        legacy.map((m) => ({
          _id: m._id,
          repo: rawChat.repo,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        })),
        { ordered: false }
      );
    } catch (error) {
      // Already migrated by an earlier or concurrent run
      const onlyDuplicates = (error.writeErrors ?? []).every(
        (e) => (e.code ?? e.err?.code) === 11000
      );
      if (!(error.code === 11000 || (error.writeErrors && onlyDuplicates))) {
        throw error;
      }
    }
  }

  const last = legacy.at(-1);
  await Chat.collection.updateOne(
    { _id: rawChat._id },
    {
      $set: last ? summaryFields(last, legacy.length) : { messageCount: 0 },
      $unset: { messages: "" },
    }
  );
  return { messages: legacy.length };
}

// The chat document for a repo, creating it if needed. Chats still in the
// old format are migrated first, so callers never see the difference.
async function getOrCreateChat(repoId) {
  let chat = await Chat.collection.findOne(
    { repo: repoId },
    { sort: { _id: 1 } }
  );
  if (chat && Array.isArray(chat.messages)) {
    await migrateLegacyChat(chat);
    logger.info("Migrated legacy chat %s", String(chat._id));
    chat = await Chat.collection.findOne({ _id: chat._id });
  }
  if (!chat) {
    chat = await Chat.findOneAndUpdate(
      { repo: repoId },
      { $setOnInsert: { repo: repoId, createdAt: new Date() } },
      { upsert: true, new: true }
    ).lean();
  }
  return chat;
}

// Adds messages in order and refreshes the chat summary. Returns the chat id.
export async function appendMessages(repoId, messages) {
  const chat = await getOrCreateChat(repoId);
  const now = Date.now();
  const docs = await ChatMessage.insertMany(
    messages.map((m, i) => ({
      repo: repoId,
      role: m.role,
      content: m.content,
      createdAt: new Date(now + i), // keeps order stable within one call
    }))
  );
  await Chat.updateOne(
    { _id: chat._id },
    {
      $set: {
        lastMessage: {
          role: docs.at(-1).role,
          content: clipPreview(docs.at(-1).content),
        },
        lastMessageAt: docs.at(-1).createdAt,
      },
      $inc: { messageCount: docs.length },
    }
  );
  return chat._id;
}

// Newest `limit` messages, oldest first. `before` (a message id) pages
// backwards. Returns { messages, chatId, hasMore } or null if no chat exists.
export async function getHistory(repoId, { limit, before } = {}) {
  const chat = await Chat.collection.findOne(
    { repo: repoId },
    { sort: { _id: 1 } }
  );
  if (!chat) return null;
  if (Array.isArray(chat.messages)) await migrateLegacyChat(chat);

  const size = Math.min(
    Math.max(Number.parseInt(limit, 10) || HISTORY_PAGE_DEFAULT, 1),
    HISTORY_PAGE_MAX
  );
  const filter = { repo: repoId };
  if (before) filter._id = { $lt: before };

  const rows = await ChatMessage.find(filter, "role content createdAt")
    .sort({ _id: -1 })
    .limit(size + 1)
    .lean();
  const hasMore = rows.length > size;
  const messages = rows.slice(0, size).reverse();
  return { messages, chatId: chat._id, hasMore };
}

// The last `n` messages, oldest first (conversation memory for the model)
export async function getRecentMessages(repoId, n) {
  const rows = await ChatMessage.find({ repo: repoId }, "role content")
    .sort({ _id: -1 })
    .limit(n)
    .lean();
  if (rows.length) return rows.reverse();

  // Nothing in the new collection: the chat may still be in the old format
  const chat = await Chat.collection.findOne({ repo: repoId });
  return Array.isArray(chat?.messages) ? chat.messages.slice(-n) : [];
}

// Summaries (preview, last activity) for many repos in one query
export async function getChatSummaries(repoIds) {
  const chats = await Chat.collection
    .find({ repo: { $in: repoIds } })
    .sort({ _id: 1 })
    .toArray();
  const byRepo = new Map();
  for (const chat of chats) {
    if (byRepo.has(String(chat.repo))) continue;
    const legacyLast = Array.isArray(chat.messages)
      ? chat.messages.at(-1)
      : null;
    byRepo.set(String(chat.repo), {
      chatId: chat._id,
      lastMessage:
        chat.lastMessage ??
        (legacyLast
          ? { role: legacyLast.role, content: legacyLast.content }
          : null),
      lastActive: chat.lastMessageAt ?? legacyLast?.createdAt ?? null,
    });
  }
  return byRepo;
}
