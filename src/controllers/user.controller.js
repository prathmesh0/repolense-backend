import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { User } from "../models/user.model.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { getChatSummaries } from "../services/chatHistory.service.js";
import jwt from "jsonwebtoken";
import Fuse from "fuse.js";
import { logger } from "../utils/logger.js";
import {
  clearAuthCookies,
  clearCookieOptions,
  setAuthCookies,
  setSessionAccessCookie,
} from "../utils/authCookies.js";
import {
  createDemoUser,
  deleteDemoUser,
  demoInfo,
} from "../services/demo.service.js";
import { demoConfig } from "../utils/demoConfig.js";

const generateAccessAndRefreshTokens = async (userId) => {
  try {
    const user = await User.findById(userId);
    const accessToken = user.generateAccessToken();
    const refreshToken = user.generateRefreshToken();

    user.refreshToken = refreshToken;
    await user.save({ validateBeforeSave: false });

    return { accessToken, refreshToken };
  } catch (error) {
    logger.error("Error details:", error);
    throw new ApiError(
      500,
      "Something went wrong while generating refresh and access token"
    );
  }
};

const registerUser = asyncHandler(async (req, res) => {
  //   get user details from frontend
  const { username, email, password } = req.body;
  //   validation
  // typeof check also blocks NoSQL operator objects like { "$ne": "" }
  if (
    [username, email, password].some(
      (field) => typeof field !== "string" || field.trim() === ""
    )
  ) {
    throw new ApiError(400, "All fields is required");
  }
  //   check if user already exist -check with email
  const existedUser = await User.findOne({ email });
  if (existedUser) {
    throw new ApiError(409, "Email already exist");
  }

  //   create user  object - Create entry in DB
  const user = await User.create({
    username: username.toLowerCase(),
    email,
    password,
  });

  //   remove password and refresh token field from response
  const createdUser = await User.findById(user._id).select(
    "-password -refreshToken"
  );

  //   check for user creation
  if (!createdUser) {
    throw new ApiError(400, "Something went wrong while registering the user");
  }
  //   return res
  return res
    .status(201)
    .json(new ApiResponse(200, createdUser, "User registered successfully"));
});

const loginUser = asyncHandler(async (req, res) => {
  // req body
  const { email, password } = req.body;
  // email
  if (typeof email !== "string" || !email.trim()) {
    throw new ApiError(400, "Email is required");
  }
  if (typeof password !== "string" || !password) {
    throw new ApiError(400, "Password is required");
  }

  // find the user
  const user = await User.findOne({ email });
  if (!user) {
    throw new ApiError(404, "User does not exist");
  }
  // password check
  const isPasswordValid = await user.isPasswordCorrect(password);
  if (!isPasswordValid) {
    throw new ApiError(401, "Invalid user credentials");
  }
  // access and refresh token generation
  const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(
    user._id
  );

  // send cookie
  const loggedInUser = await User.findById(user._id).select(
    "-password -refreshToken"
  );

  return setAuthCookies(res.status(200), accessToken, refreshToken).json(
      new ApiResponse(
        200,
        {
          user: loggedInUser,
          accessToken,
          refreshToken,
        },
        "User logged in successfully"
      )
    );
});

// Fields of a user that are safe to return, plus the demo block for guests
const publicUser = (user) => ({
  _id: user._id,
  username: user.username,
  email: user.isDemo ? undefined : user.email,
  createdAt: user.createdAt,
  isDemo: Boolean(user.isDemo),
  ...(user.isDemo ? { demo: demoInfo(user) } : {}),
});

// One click, no registration: creates a temporary guest user with a
// browser-session cookie, no refresh token, and a hard expiry.
const demoLogin = asyncHandler(async (req, res) => {
  if (!demoConfig().enabled) {
    throw new ApiError(503, "The live demo is not available right now.", [
      { code: "DEMO_DISABLED" },
    ]);
  }

  const { user, accessToken } = await createDemoUser();
  logger.info({ event: "demo_login" }, "Demo login");

  // A stale refresh cookie from an earlier real login must not outlive this
  res.clearCookie("refreshToken", clearCookieOptions());
  return setSessionAccessCookie(res.status(200), accessToken).json(
    new ApiResponse(
      200,
      { user: publicUser(user), accessToken },
      "Demo session started"
    )
  );
});

const logoutUser = asyncHandler(async (req, res) => {
  // "End demo": the guest and everything it owns is deleted right away
  if (req.user.isDemo) {
    await deleteDemoUser(req.user._id);
    return clearAuthCookies(res.status(200)).json(
      new ApiResponse(200, {}, "Demo ended and data deleted")
    );
  }

  await User.findByIdAndUpdate(
    req.user._id,
    {
      $set: {
        refreshToken: undefined,
      },
    },
    {
      new: true,
    }
  );

  return clearAuthCookies(res.status(200)).json(new ApiResponse(200, {}, "User logged Out"));
});

const refreshAccessToken = asyncHandler(async (req, res) => {
  const incomingRefreshToken =
    req.cookies?.refreshToken || req.body?.refreshToken;

  if (!incomingRefreshToken) {
    throw new ApiError(401, "Unauthorized request");
  }

  try {
    const decodedToken = jwt.verify(
      incomingRefreshToken,
      process.env.REFRESH_TOKEN_SECRET
    );

    const user = await User.findById(decodedToken?._id);

    if (!user) {
      throw new ApiError(401, "Invalid Refresh Token");
    }

    if (incomingRefreshToken !== user?.refreshToken) {
      throw new ApiError(401, "Refresh Token is expired or used");
    }

    const { accessToken, refreshToken: newRefreshToken } =
      await generateAccessAndRefreshTokens(user._id);
    return setAuthCookies(res.status(200), accessToken, newRefreshToken).json(
        new ApiResponse(
          200,
          {
            accessToken,
            refreshToken: newRefreshToken,
          },
          "Access token refreshed successfully"
        )
      );
  } catch (error) {
    throw new ApiError(401, error?.message || "Invalid refresh token");
  }
});

const getUserRepoHistoryAndChats = asyncHandler(async (req, res) => {
  const { query } = req.query;
  const userId = req.user?._id;

  if (!userId) throw new ApiError(401, "Unauthorized: User not found");

  const user = await User.findById(userId)
    .populate({
      path: "repoHistory",
      options: { sort: { createdAt: -1 } },
    })
    .lean();
  if (!user) throw new ApiError(404, "User not found");

  let filteredRepos = user.repoHistory;

  if (query) {
    // Initialize Fuse.js with repo names
    const fuse = new Fuse(user.repoHistory, {
      keys: ["name"], // field to search within
      threshold: 0.4, // lower = stricter match, higher = looser
      includeScore: true,
      ignoreLocation: true,
    });

    // Perform the fuzzy search
    const results = fuse.search(query);

    // Extract matched repos in ranked order
    filteredRepos = results.map((r) => r.item);
  }

  // Chat summaries for all repos in one query
  const summaries = await getChatSummaries(
    filteredRepos.map((r) => r._id),
    userId
  );
  const repoChats = filteredRepos.map((repo) => {
    const chat = summaries.get(String(repo._id));
    return {
      repoId: repo._id,
      repoName: repo.name,
      repoOwner: repo.owner,
      messagePreview: chat?.lastMessage
        ? { role: chat.lastMessage.role, content: chat.lastMessage.content }
        : null,
      chatId: chat?.chatId ?? null,
      lastActive: chat?.lastActive ?? repo.createdAt,
    };
  });

  // Sort repos by last active chat
  repoChats.sort(
    (a, b) => new Date(b.lastActive || 0) - new Date(a.lastActive || 0)
  );

  return res.json(
    new ApiResponse(
      200,
      repoChats,
      query
        ? `Fuzzy search results for '${query}' fetched successfully`
        : "All repositories fetched successfully"
    )
  );
});

// Who am I: the single source of truth for the logged-in state
const getCurrentUser = asyncHandler(async (req, res) => {
  return res.json(new ApiResponse(200, publicUser(req.user), "Current user"));
});

export {
  demoLogin,
  getCurrentUser,
  registerUser,
  loginUser,
  logoutUser,
  refreshAccessToken,
  getUserRepoHistoryAndChats,
};
