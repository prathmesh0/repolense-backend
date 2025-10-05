import mongoose from "mongoose";

const analysisSchema = new mongoose.Schema({
  repo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Repo",
    required: true,
  },
  summary: {
    type: String,
  }, // AI generated description
  complexity: {
    type: String,
  }, // e.g. Low / Medium / High
  potentialIssues: [
    {
      type: String,
    },
  ], // AI detected problems
  architecture: {
    type: String,
  }, // e.g. MVC, Monolith, Microservices
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

export const Analysis = mongoose.model("Analysis", analysisSchema);
