import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import {
  chatWithRepo,
  chatWithRepoStream,
  HISTORY_MAX_MESSAGES,
} from "../services/chat.service.js";
import { Chat } from "../models/chat.model.js";
import { logger } from "../utils/logger.js";

const MAX_QUESTION_LENGTH = 2000;

function readQuestion(req) {
  const { question } = req.body;
  if (typeof question !== "string" || !question.trim()) {
    throw new ApiError(400, "Question is required");
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new ApiError(
      400,
      `Question must be at most ${MAX_QUESTION_LENGTH} characters`
    );
  }
  return question.trim();
}

// The last few stored messages, oldest first (conversation memory)
async function loadRecentMessages(repoId) {
  const chat = await Chat.findOne(
    { repo: repoId },
    { messages: { $slice: -HISTORY_MAX_MESSAGES } }
  ).lean();
  return chat?.messages ?? [];
}

// Atomic append, so two messages sent at once cannot overwrite each other
async function saveExchange(repoId, question, answer) {
  const chat = await Chat.findOneAndUpdate(
    { repo: repoId },
    {
      $push: {
        messages: {
          $each: [
            { role: "user", content: question },
            { role: "assistant", content: answer },
          ],
        },
      },
      $setOnInsert: { repo: repoId },
    },
    { upsert: true, new: true }
  );
  return chat._id;
}

const sse = (res, event, data) =>
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

// POST /chat/:repoId?stream=true  ->  text/event-stream
//   event: sources  {sources}
//   event: token    {text}          (many)
//   event: done     {chatId}
//   event: error    {message}
async function streamChat(req, res, question) {
  const repoId = req.repo._id;
  const messages = await loadRecentMessages(repoId);

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const stream = chatWithRepoStream(
    repoId,
    question,
    messages,
    controller.signal
  );

  // Pull the first event before opening the stream, so retrieval problems
  // (no embeddings yet, ...) still come back as a normal JSON error.
  const first = await stream.next();

  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  let answer = "";
  try {
    let step = first;
    while (!step.done) {
      const event = step.value;
      if (event.type === "sources") {
        sse(res, "sources", { sources: event.sources });
      } else {
        answer += event.text;
        sse(res, "token", { text: event.text });
      }
      step = await stream.next();
    }

    if (controller.signal.aborted) return; // client left: nothing to save
    const chatId = await saveExchange(repoId, question, answer);
    sse(res, "done", { chatId });
  } catch (error) {
    if (!controller.signal.aborted) {
      logger.error(error, "Chat stream failed");
      sse(res, "error", {
        message: "Could not finish the answer, please try again.",
      });
    }
  } finally {
    res.end();
  }
}

// Both handlers run after requireOwnedRepo, so req.repo belongs to the user
export const chatWithRepoController = asyncHandler(async (req, res) => {
  const repoId = req.repo._id;
  const question = readQuestion(req);

  if (req.query.stream === "true") return streamChat(req, res, question);

  const messages = await loadRecentMessages(repoId);
  const { answer, sources } = await chatWithRepo(repoId, question, messages);
  const chatId = await saveExchange(repoId, question, answer);

  return res
    .status(200)
    .json(new ApiResponse(200, { answer, sources, chatId }, "Chat success"));
});

export const getChatHistoryForRepo = asyncHandler(async (req, res) => {
  const chat = await Chat.findOne({ repo: req.repo._id });

  // Reads must not write: return an empty history without creating a chat
  if (!chat) {
    return res.json(
      new ApiResponse(
        200,
        { messages: [], chatId: null },
        "No chat history found"
      )
    );
  }

  return res.json(
    new ApiResponse(
      200,
      { messages: chat.messages, chatId: chat._id },
      "Chat history fetched"
    )
  );
});
