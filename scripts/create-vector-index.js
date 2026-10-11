// Creates the Atlas Vector Search index used by chat retrieval:
//   npm run create:vector-index
// Works on MongoDB Atlas only. You can also create it in the Atlas UI
// (Search -> Create Search Index -> JSON editor) with the same definition.
import "dotenv/config";
import mongoose from "mongoose";
import { DB_NAME } from "../src/constants.js";
import { Embedding } from "../src/models/embedding.model.js";
import { VECTOR_INDEX_NAME } from "../src/services/retrieval.service.js";

const definition = {
  fields: [
    // all-MiniLM-L6-v2 produces 384-dimension vectors
    {
      type: "vector",
      path: "vector",
      numDimensions: 384,
      similarity: "cosine",
    },
    // lets $vectorSearch restrict results to one repository
    { type: "filter", path: "repo" },
  ],
};

async function main() {
  await mongoose.connect(`${process.env.MONGODB_URI}/${DB_NAME}`);

  const existing = await Embedding.collection.listSearchIndexes().toArray();
  if (existing.some((i) => i.name === VECTOR_INDEX_NAME)) {
    console.log(`Index "${VECTOR_INDEX_NAME}" already exists.`);
  } else {
    await Embedding.collection.createSearchIndex({
      name: VECTOR_INDEX_NAME,
      type: "vectorSearch",
      definition,
    });
    console.log(
      `Created "${VECTOR_INDEX_NAME}". Atlas builds it in the background; it can take a minute before it is queryable.`
    );
  }
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(
    "Could not create the vector index (is this an Atlas cluster?):",
    error.message
  );
  process.exit(1);
});
