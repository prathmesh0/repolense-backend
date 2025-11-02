import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/apiError.js";
import { User } from "../models/user.model.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { Chat } from "../models/chat.model.js";
import jwt from "jsonwebtoken";

const generateAccessAndRefreshTokens = async (userId) => {
  try {
    const user = await User.findById(userId);
    const accessToken = user.generateAccessToken();
    const refreshToken = user.generateRefreshToken();

    user.refreshToken = refreshToken;
    await user.save({ validateBeforeSave: false });

    return { accessToken, refreshToken };
  } catch (error) {
    console.error("Error details:", error);
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
  if (
    [username, email, password].some((field) => !field || field.trim() === "")
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
  if (!email) {
    throw new ApiError(400, "Email is required");
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

  const options = {
    httpsOnly: true,
    secure: true,
  };

  return res
    .status(200)
    .cookie("accessToken", accessToken, options)
    .cookie("refreshToken", refreshToken, options)
    .json(
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

const logoutUser = asyncHandler(async (req, res) => {
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

  const options = {
    httpsOnly: true,
    secure: true,
  };

  return res
    .status(200)
    .clearCookie("accessToken", options)
    .clearCookie("refreshToken", options)
    .json(new ApiResponse(200, {}, "User logged Out"));
});

const refreshAccessToken = asyncHandler(async (req, res) => {
  const incomingRefreshToken =
    req.cookies.refreshToken || req.body.refreshToken;

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

    const options = {
      httpOnly: true,
      secure: true,
    };

    const { accessToken, refreshToken: newRefreshToken } =
      await generateAccessAndRefreshTokens(user._id);
    return res
      .status(200)
      .cookie("accessToken", accessToken, options)
      .cookie("refreshToken", newRefreshToken, options)
      .json(
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
  const user = await User.findById(req.user._id).populate("repoHistory");

  if (!user) throw new ApiError(404, "User not found");
  // Fetch latest chat message for each repo
  const repoChats = await Promise.all(
    user.repoHistory.map(async (repo) => {
      const chat = await Chat.findOne({ repo: repo._id });
      // Optionally, only return last message preview
      const latestMessage = chat?.messages[chat.messages.length - 1];
      return {
        repoId: repo._id,
        repoName: repo.name,
        repoOwner: repo.owner,
        messagePreview: latestMessage
          ? { role: latestMessage.role, content: latestMessage.content }
          : null,
        chatId: chat?._id ?? null,
        lastActive: chat?.updatedAt ?? null,
      };
    })
  );

  // Sort repos by lastActive (recent first)
  repoChats.sort(
    (a, b) => new Date(b.lastActive || 0) - new Date(a.lastActive || 0)
  );

  return res.json(new ApiResponse(200, repoChats, "Repo chat history fetched"));
});
export {
  registerUser,
  loginUser,
  logoutUser,
  refreshAccessToken,
  getUserRepoHistoryAndChats,
};
