import mongoose, { Schema } from "mongoose";

// A unit of background work (currently: analyse one repository).
// Stored in MongoDB so queued work survives restarts and any server instance
// can pick it up.
const jobSchema = new Schema(
  {
    type: { type: String, default: "analyse-repo" },
    repo: { type: Schema.Types.ObjectId, ref: "Repo", required: true },
    payload: {
      owner: String,
      name: String,
    },
    status: {
      type: String,
      enum: ["queued", "running", "done", "failed"],
      default: "queued",
    },
    // true while queued or running; lets the database enforce "one live job
    // per repo" through a partial unique index
    active: { type: Boolean, default: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 2 },
    runAt: { type: Date, default: Date.now },
    // lease: the worker refreshes lockedAt while running; if it goes stale the
    // worker is presumed dead and the job is retried or failed
    lockedAt: Date,
    lockedBy: String,
    lastError: String,
    finishedAt: Date,
  },
  { timestamps: true }
);

jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index(
  { repo: 1 },
  { unique: true, partialFilterExpression: { active: true } }
);
// Finished jobs are removed after a week
jobSchema.index({ finishedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export const Job = mongoose.model("Job", jobSchema);
