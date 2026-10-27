import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchEmbeddingBatch } from "../src/fetch-embedding.ts";
import type { EmbeddingDeps } from "../src/types.ts";

const cfg = { endpoint: "http://127.0.0.1:1234/v1/embeddings", model: "m" };

/** Build a deps stub from a sequence of responses (cycles on last entry). */
function stubDeps(
  seq: Array<{ ok: boolean; status?: number; statusText?: string; json?: unknown; text?: string }>,
): EmbeddingDeps {
  let i = 0;
  return {
    fetch: async () => {
      const r = seq[Math.min(i++, seq.length - 1)];
      return {
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 500),
        statusText: r.statusText ?? (r.ok ? "OK" : "Error"),
        json: async () => r.json,
        text: async () => r.text ?? "",
      };
    },
    isNetworkError: (e) => e instanceof TypeError,
  };
}

// (a) 3 texts → 3 vectors in correct index order
test("3 texts returns 3 vectors in correct index order", async () => {
  const deps = stubDeps([
    {
      ok: true,
      json: {
        data: [
          { index: 2, embedding: [0.3, 0.3] },
          { index: 0, embedding: [0.1, 0.1] },
          { index: 1, embedding: [0.2, 0.2] },
        ],
      },
    },
  ]);
  const r = await fetchEmbeddingBatch(["a", "b", "c"], cfg, deps);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.vectors[0], [0.1, 0.1]);
  assert.deepEqual(r.vectors[1], [0.2, 0.2]);
  assert.deepEqual(r.vectors[2], [0.3, 0.3]);
});

// (b) oversize (413) on full batch → split and succeed on halves
test("413 on full batch splits and retries halves, returning all vectors", async () => {
  // First call: 413 on the full batch of 2 texts.
  // After split: first half (["a"]) and second half (["b"]) each get ok responses.
  let call = 0;
  const deps: EmbeddingDeps = {
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      call++;
      if (body.input.length === 2) {
        // Full batch → 413
        return { ok: false, status: 413, statusText: "Payload Too Large", json: async () => null, text: async () => "payload too large" };
      }
      // Half batches: return index=0 embedding based on input text
      const text = body.input[0];
      const embedding = text === "a" ? [1, 0] : [0, 1];
      return {
        ok: true, status: 200, statusText: "OK",
        json: async () => ({ data: [{ index: 0, embedding }] }),
        text: async () => "",
      };
    },
  };
  const r = await fetchEmbeddingBatch(["a", "b"], cfg, deps);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.vectors[0], [1, 0]);
  assert.deepEqual(r.vectors[1], [0, 1]);
  assert.ok(call >= 3, `expected at least 3 fetch calls (got ${call})`);
});

// (c) http error → all null with error string
test("non-oversize HTTP error returns all-null vectors with error", async () => {
  const deps = stubDeps([{ ok: false, status: 401, statusText: "Unauthorized", text: "bad auth" }]);
  const r = await fetchEmbeddingBatch(["x", "y"], cfg, deps);
  assert.ok(r.vectors.every((v) => v === null), "expected all null vectors");
  assert.match(r.error!, /API 401/);
});

// (d) empty input → empty vectors array, no fetch call
test("empty texts returns empty vectors without fetching", async () => {
  let called = false;
  const deps: EmbeddingDeps = {
    fetch: async () => { called = true; return { ok: true, status: 200, statusText: "OK", json: async () => ({}), text: async () => "" }; },
  };
  const r = await fetchEmbeddingBatch([], cfg, deps);
  assert.deepEqual(r.vectors, []);
  assert.equal(called, false);
});

// (e) missing data[] in response → all null with specific error
test("response missing data[] returns all-null with error message", async () => {
  const deps = stubDeps([{ ok: true, json: { result: [] } }]);
  const r = await fetchEmbeddingBatch(["a", "b"], cfg, deps);
  assert.ok(r.vectors.every((v) => v === null));
  assert.match(r.error!, /missing data\[\]/);
});

// (f) network error → all null with network error message
test("network error returns all-null vectors with error", async () => {
  const deps: EmbeddingDeps = {
    fetch: async () => { throw new TypeError("fetch failed"); },
    isNetworkError: (e) => e instanceof TypeError,
  };
  const r = await fetchEmbeddingBatch(["x"], cfg, deps);
  assert.ok(r.vectors.every((v) => v === null));
  assert.match(r.error!, /Network error reaching/);
});

// (g) no endpoint → all null, no fetch
test("no endpoint returns all-null without fetching", async () => {
  let called = false;
  const deps: EmbeddingDeps = {
    fetch: async () => { called = true; return { ok: true, status: 200, statusText: "OK", json: async () => ({}), text: async () => "" }; },
  };
  const r = await fetchEmbeddingBatch(["a", "b"], { endpoint: "", model: "m" }, deps);
  assert.ok(r.vectors.every((v) => v === null));
  assert.equal(called, false);
});

test("replaces lone UTF-16 surrogates before sending a batch", async () => {
  let sentInput: string[] = [];
  const deps: EmbeddingDeps = {
    fetch: async (_url, init) => {
      sentInput = JSON.parse(init.body).input;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: sentInput.map((_, index) => ({ index, embedding: [index + 1] })),
        }),
        text: async () => "",
      };
    },
  };

  const r = await fetchEmbeddingBatch(
    ["valid \ud83d\ude03", "broken high \ud83d", "broken low \udc00"],
    cfg,
    deps,
  );

  assert.deepEqual(sentInput, ["valid 😃", "broken high �", "broken low �"]);
  assert.deepEqual(r.vectors, [[1], [2], [3]]);
});
