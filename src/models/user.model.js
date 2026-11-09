import mongoose, { Schema } from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

const userSchema = new Schema(
  {
    username: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    repoHistory: [
      {
        type: Schema.Types.ObjectId,
        ref: "Repo",
      },
    ],
    password: {
      type: String,
      required: [true, "Password is required"],
    },
    refreshToken: {
      type: String,
    },

    // Demo guests: temporary users created by POST /users/demo-login.
    // Everything they own is deleted at expiresAt (see demo.service.js).
    isDemo: { type: Boolean, default: false },
    expiresAt: { type: Date },
    demoAnalysesUsed: { type: Number, default: 0 },
    demoChatCount: { type: Number, default: 0 },
  },
  {
    timestamps: true,
  }
);

// The sweeper looks for expired guests
userSchema.index({ expiresAt: 1 }, { sparse: true });

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();

  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.isPasswordCorrect = async function (password) {
  return await bcrypt.compare(password, this.password);
};

userSchema.methods.generateAccessToken = function (
  expiresIn = process.env.ACCESS_TOKEN_EXPIRY
) {
  return jwt.sign(
    {
      _id: this._id,
      email: this.email,
      username: this.username,
    },
    process.env.ACCESS_TOKEN_SECRET,
    {
      expiresIn,
    }
  );
};
userSchema.methods.generateRefreshToken = function () {
  return jwt.sign(
    {
      _id: this._id,
    },
    process.env.REFRESH_TOKEN_SECRET,
    {
      expiresIn: process.env.REFRESH_TOKEN_EXPIRY,
    }
  );
};

export const User = mongoose.model("User", userSchema);
