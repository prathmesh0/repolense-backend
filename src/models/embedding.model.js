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
    required: true,
  },
  content: {
    type: String,
    required: true,
  }, // chunk of file
  embedding: [
    {
      type: Number,
    },
  ], // vector representation
});

export default mongoose.model("Embedding", embeddingSchema);
