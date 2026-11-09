import mongoose from "mongoose";

const chatMessageSchema = new mongoose.Schema({
  repo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Repo",
    required: true,
  },
  // Set only for messages on a shared sample repo (one chat per guest)
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  role: { type: String, enum: ["user", "assistant"], required: true },
  content: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

// History reads: newest N for a repo, and paging backwards by _id
chatMessageSchema.index({ repo: 1, _id: -1 });
chatMessageSchema.index({ user: 1 }, { sparse: true });

export const ChatMessage = mongoose.model("ChatMessage", chatMessageSchema);
