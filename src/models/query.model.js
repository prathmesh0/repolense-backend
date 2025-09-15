import mongoose from "mongoose";

const querySchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  repo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Repo",
    required: true,
  },
  question: {
    type: String,
    required: true,
  },
  answer: {
    type: String,
  },
  relevantFiles: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "File",
    },
  ],
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.model("Query", querySchema);
