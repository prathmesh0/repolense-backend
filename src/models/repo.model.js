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

    // Pre-analysed demo repo, readable (not editable) by every logged-in user
    isSample: { type: Boolean, default: false },
    // Created by a demo guest; lets the cleanup find orphans of deleted guests
    ownerIsDemo: { type: Boolean, default: false },

    // Live progress of the long-running stages
    progress: {
      fileStructure: {
        done: { type: Number, default: 0 },
        total: { type: Number, default: 0 },
      },
      embedding: {
        done: { type: Number, default: 0 },
        total: { type: Number, default: 0 },
      },
    },
    // Short user-facing reason when a stage failed
    statusErrors: {
      fileStructure: String,
      ai: String,
      embedding: String,
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index for (url, user)
repoSchema.index({ url: 1, user: 1 }, { unique: true });

repoSchema.index({ isSample: 1 }, { partialFilterExpression: { isSample: true } });
repoSchema.index(
  { ownerIsDemo: 1 },
  { partialFilterExpression: { ownerIsDemo: true } }
);

export const Repo = mongoose.model("Repo", repoSchema);
