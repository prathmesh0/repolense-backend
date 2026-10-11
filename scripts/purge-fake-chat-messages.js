// One-off: removes the label / JSON-dump messages that getRepoInfo used to
// store in chat history (it no longer does). Real questions and answers stay.
//   node scripts/purge-fake-chat-messages.js           (dry run)
//   node scripts/purge-fake-chat-messages.js --apply   (deletes them)
// Run it only after the new frontend (which builds its cards from
// getRepoInfo, not from chat history) is live. Chats not yet moved to the
// ChatMessage collection should be migrated first: npm run migrate:chat -- --apply
import "dotenv/config";
import mongoose from "mongoose";
import { DB_NAME } from "../src/constants.js";
import { purgeFakeMessages } from "../src/services/chatHistory.service.js";

const apply = process.argv.includes("--apply");

async function main() {
  await mongoose.connect(`${process.env.MONGODB_URI}/${DB_NAME}`);
  console.log(apply ? "APPLY mode" : "DRY RUN (pass --apply to change data)");
  console.log(await purgeFakeMessages({ apply }));
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
