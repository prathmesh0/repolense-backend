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
      unique: true,
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
    lastSynced: {
      type: Date,
      default: Date.now,
    },
    description: {
      type: String,
    }, // AI generated project summary
    techStack: [
      {
        type: String,
      },
    ], // AI detected technologies
    fileStructure: {
      type: Object,
    }, // AI generated file tree
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    }, // who added this repo
  },
  {
    timestamps: true,
  }
);

export const Repo = mongoose.model("Repo", repoSchema);
