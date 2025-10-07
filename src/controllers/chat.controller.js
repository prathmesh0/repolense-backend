import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { chatWithRepo } from "../services/chat.service.js";
import { Chat } from "../models/chat.model.js";

export const chatWithRepoController = asyncHandler(async (req, res) => {
  const { repoId } = req.params;
  const { question } = req.body;

  if (!question) throw new ApiError(400, "Question is required");

  //   Run chat Service
  const { answer, sources } = await chatWithRepo(repoId, question);

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
