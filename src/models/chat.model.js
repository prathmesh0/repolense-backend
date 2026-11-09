import mongoose from "mongoose";

// One document per repo: the chat's identity and a summary for list views.
// The messages themselves live in the ChatMessage collection. Documents
// written before that move still carry a `messages` array; the chat history
// service migrates them on first access (see scripts/migrate-chat-messages.js).
const chatSchema = new mongoose.Schema({
  repo: { type: mongoose.Schema.Types.ObjectId, ref: "Repo", required: true },
  // Set only for chats on a shared sample repo, where every guest has their own
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  lastMessage: {
    role: { type: String, enum: ["user", "assistant"] },
    content: String,
  },
  lastMessageAt: Date,
  messageCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

chatSchema.index({ repo: 1 });
chatSchema.index({ user: 1 }, { sparse: true });

export const Chat = mongoose.model("Chat", chatSchema);
