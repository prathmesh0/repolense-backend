// One-off cleanup for data stored before secret filtering existed:
//   node scripts/purge-sensitive-data.js           (dry run, changes nothing)
//   node scripts/purge-sensitive-data.js --apply   (performs the cleanup)
//
// - deletes File documents at credential paths (.env, *.pem, id_rsa, ...)
//   together with their embeddings
// - redacts API keys / private keys / DB passwords inside other files and
//   inside stored embedding previews
import "dotenv/config";
import mongoose from "mongoose";
import { DB_NAME } from "../src/constants.js";
import { File } from "../src/models/file.model.js";
import { Embedding } from "../src/models/embedding.model.js";
import { isSensitivePath, redactSecrets } from "../src/utils/secrets.js";

const apply = process.argv.includes("--apply");

async function main() {
  await mongoose.connect(`${process.env.MONGODB_URI}/${DB_NAME}`);
  console.log(apply ? "APPLY mode" : "DRY RUN (pass --apply to change data)");

  const stats = {
    filesScanned: 0,
    sensitiveFiles: 0,
    redactedFiles: 0,
    redactedPreviews: 0,
  };

  for await (const file of File.find({}, "repo path content").cursor()) {
    stats.filesScanned++;

    if (isSensitivePath(file.path)) {
      stats.sensitiveFiles++;
      console.log("delete  ", file.path, String(file.repo));
      if (apply) {
        await Embedding.deleteMany({ file: file._id });
        await File.deleteOne({ _id: file._id });
      }
      continue;
    }

    const cleaned = file.content ? redactSecrets(file.content) : file.content;
    if (cleaned !== file.content) {
      stats.redactedFiles++;
      console.log("redact  ", file.path, String(file.repo));
      if (apply)
        await File.updateOne({ _id: file._id }, { $set: { content: cleaned } });
    }
  }

  // Embeddings of files that were already removed, or previews with secrets
  for await (const emb of Embedding.find({}, "path contentPreview").cursor()) {
    if (isSensitivePath(emb.path ?? "")) {
      if (apply) await Embedding.deleteOne({ _id: emb._id });
      continue;
    }
    const cleaned = emb.contentPreview
      ? redactSecrets(emb.contentPreview)
      : emb.contentPreview;
    if (cleaned !== emb.contentPreview) {
      stats.redactedPreviews++;
      if (apply)
        await Embedding.updateOne(
          { _id: emb._id },
          { $set: { contentPreview: cleaned } }
        );
    }
  }

  console.log(stats);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
