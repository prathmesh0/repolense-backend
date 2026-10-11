import mongoose from "mongoose";

const fileSchema = new mongoose.Schema(
  {
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
    content: {
      type: String, // 🔑 decoded file contents
    },
  },
  {
    timestamps: true,
  }
);

fileSchema.index({ repo: 1, path: 1 });

export const File = mongoose.model("File", fileSchema);
