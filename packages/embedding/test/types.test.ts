import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmbeddingConfig, EmbeddingResult } from "../src/types.ts";

test("types are importable and shaped", () => {
  const cfg: EmbeddingConfig = { endpoint: "http://x/v1/embeddings", model: "m" };
  const r: EmbeddingResult = { vector: [0.1, 0.2] };
  assert.equal(cfg.model, "m");
  assert.equal(r.vector?.length, 2);
});
