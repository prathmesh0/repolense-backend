import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ["user", "assistant"],
    required: true,
  },
  content: {
    type: String,
    required: true,
  },

  createdAt: { type: Date, default: Date.now },
});

const chatSchema = new mongoose.Schema({
  repo: { type: mongoose.Schema.Types.ObjectId, ref: "Repo", required: true },
  messages: [messageSchema],
  createdAt: { type: Date, default: Date.now },
});

export const Chat = mongoose.model("Chat", chatSchema);
