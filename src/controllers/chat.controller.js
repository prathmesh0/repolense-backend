import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { chatWithRepo } from "../services/chat.service.js";
import { Chat } from "../models/chat.model.js";

const MAX_QUESTION_LENGTH = 2000;

// Both handlers run after requireOwnedRepo, so req.repo belongs to the user
export const chatWithRepoController = asyncHandler(async (req, res) => {
  const repoId = req.repo._id;
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

  //   Run chat Service
  const { answer, sources } = await chatWithRepo(repoId, question.trim());

  //   Save to chat history
  let chat = await Chat.findOne({ repo: repoId });
  if (!chat) chat = await Chat.create({ repo: repoId, messages: [] });

  chat.messages.push({ role: "user", content: question });
  chat.messages.push({ role: "assistant", content: answer });
  await chat.save();

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { answer, sources, chatId: chat._id },
        "Chat success"
      )
    );
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
