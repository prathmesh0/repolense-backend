// One-off: moves chat messages from the old single-document format
// (Chat.messages array) into the ChatMessage collection.
//   node scripts/migrate-chat-messages.js           (dry run, changes nothing)
//   node scripts/migrate-chat-messages.js --apply   (migrates)
//
// Optional: the app also migrates a chat the first time it is used, so this
// script just finishes the rest. It is safe to re-run.
import "dotenv/config";
import mongoose from "mongoose";
import { DB_NAME } from "../src/constants.js";
import { Chat } from "../src/models/chat.model.js";
import { migrateLegacyChat } from "../src/services/chatHistory.service.js";

const apply = process.argv.includes("--apply");

async function main() {
  await mongoose.connect(`${process.env.MONGODB_URI}/${DB_NAME}`);
  console.log(apply ? "APPLY mode" : "DRY RUN (pass --apply to change data)");

  const stats = { chats: 0, messages: 0 };
  // raw collection: the schema no longer declares `messages`
  const cursor = Chat.collection.find({ messages: { $exists: true } });
  for await (const chat of cursor) {
    const { messages } = await migrateLegacyChat(chat, { apply });
    stats.chats++;
    stats.messages += messages;
    console.log(
      `${apply ? "migrated" : "would migrate"} chat ${chat._id}: ${messages} messages`
    );
  }

  console.log(stats);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
