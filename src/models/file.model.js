import mongoose from "mongoose";

const fileSchema = new mongoose.Schema({
  repo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Repo",
    required: true,
  },
  path: {
    type: String,
    required: true,
  },

  type: {
    type: String,
    enum: ["file", "dir"],
    required: true,
  },
  size: {
    type: Number,
    default: 0,
  },
  extension: {
    type: String,
  },
});

export default mongoose.model("File", fileSchema);
