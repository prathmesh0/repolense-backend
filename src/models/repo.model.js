import mongoose, { Schema } from "mongoose";

const repoSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    owner: {
      type: String,
      required: true,
    },
    url: {
      type: String,
      required: true,
    },
    stars: {
      type: Number,
      default: 0,
    },
    forks: {
      type: Number,
      default: 0,
    },
    watchers: {
      type: Number,
      default: 0,
    },
    commitCount: {
      type: Number,
      default: 0,
    },
    branches: [
      {
        type: String,
      },
    ],
    contributors: [
      {
        type: String,
      },
    ],
    languages: [
      {
        type: String,
      },
    ],
    lastSynced: {
      type: Date,
      default: Date.now,
    },
    description: {
      type: String,
    }, // AI generated project summary
    // techStack: [
    //   {
    //     type: String,
    //   },
    // ], // AI detected technologies
    fileStructure: {
      type: Object,
    },
    aiAnalysis: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Analysis",
    }, // AI generated file tree

    fileStructureStatus: {
      type: String,
      enum: ["pending", "processing", "ready", "failed"],
      default: "pending",
    },
    aiStatus: {
      type: String,
      enum: ["pending", "processing", "ready", "failed"],
      default: "pending",
    },
    embeddingStatus: {
      type: String,
      enum: ["pending", "processing", "ready", "failed"],
      default: "pending",
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    }, // who added this repo
  },
  {
    timestamps: true,
  }
);

// Compound unique index for (url, user)
repoSchema.index({ url: 1, user: 1 }, { unique: true });

export const Repo = mongoose.model("Repo", repoSchema);
