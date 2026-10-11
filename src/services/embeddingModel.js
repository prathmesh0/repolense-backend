import { pipeline } from "@xenova/transformers";

let embeddingModel = null;
let loading = null;

// One shared, lazily-loaded model for ingestion and chat
async function loadEmbeddingModel() {
  if (embeddingModel) return embeddingModel;
  // Share the in-flight load so concurrent callers don't load it twice
  loading ??= pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
    .then((model) => {
      embeddingModel = model;
      console.log("✅ Embedding model loaded");
      return model;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

// Embeds one text at a time on purpose: batching several texts into one model
// call gave no CPU speedup and shifted the vectors (padding), which would
// make stored vectors slightly inconsistent with single-text chat queries.
export async function embedText(text) {
  const model = await loadEmbeddingModel();
  const output = await model(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}
