import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isGoogleEmbeddingConfig, googleEmbeddingEndpoint, googleEmbeddingBody,
  looksLikeOversizeError, isNonEmptyNumberArray, isSafeExtraHeader, isLocalOrPrivateHttpEndpoint,
} from "../src/providers.ts";

test("openai-style config is not detected as google", () => {
  assert.equal(isGoogleEmbeddingConfig({ endpoint: "http://127.0.0.1:1234/v1/embeddings", model: "m" }), false);
});

test("google endpoint detection + embedContent URL", () => {
  const cfg = { endpoint: "https://generativelanguage.googleapis.com/v1beta", model: "text-embedding-004" };
  assert.equal(isGoogleEmbeddingConfig(cfg), true);
  assert.match(googleEmbeddingEndpoint(cfg), /:embedContent$/);
});

test("googleEmbeddingBody includes output_dimensionality when positive", () => {
  const b = googleEmbeddingBody("text-embedding-004", "hi", 256);
  assert.equal((b as any).output_dimensionality, 256);
  assert.equal((googleEmbeddingBody("m", "hi") as any).output_dimensionality, undefined);
});

test("oversize detection + helpers", () => {
  assert.equal(looksLikeOversizeError(413, "payload too large"), true);
  assert.equal(isNonEmptyNumberArray([1, 2, 3]), true);
  assert.equal(isNonEmptyNumberArray([]), false);
  assert.equal(isSafeExtraHeader("X-Custom", "v"), true);
  assert.equal(isSafeExtraHeader("authorization", "v"), false);
  assert.equal(isLocalOrPrivateHttpEndpoint("http://127.0.0.1:1234/v1/embeddings"), true);
});
