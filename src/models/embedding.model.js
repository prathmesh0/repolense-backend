import mongoose from "mongoose";

const embeddingSchema = new mongoose.Schema({
  repo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Repo",
    required: true,
  },
  file: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "File",
  },
  path: {
    type: String,
  },
  vector: {
    type: [Number], // array of floats (embedding)
    required: true,
  },
  contentPreview: {
    type: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

export const Embedding = mongoose.model("Embedding", embeddingSchema);
