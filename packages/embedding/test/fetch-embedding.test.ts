import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchEmbedding } from "../src/fetch-embedding.ts";
import type { EmbeddingDeps } from "../src/types.ts";

function depsReturning(seq: Array<{ ok: boolean; status?: number; json?: unknown; text?: string }>): EmbeddingDeps {
  let i = 0;
  return {
    fetch: async () => {
      const r = seq[Math.min(i++, seq.length - 1)];
      return {
        ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), statusText: "x",
        json: async () => r.json, text: async () => r.text ?? "",
      };
    },
  };
}

const cfg = { endpoint: "http://127.0.0.1:1234/v1/embeddings", model: "m" };

test("openai happy path returns the vector", async () => {
  const deps = depsReturning([{ ok: true, json: { data: [{ embedding: [0.1, 0.2, 0.3] }] } }]);
  const r = await fetchEmbedding("hello", cfg, deps);
  assert.deepEqual(r.vector, [0.1, 0.2, 0.3]);
  assert.equal(r.error, undefined);
});

test("oversize -> auto-halve retry then succeed", async () => {
  const deps = depsReturning([
    { ok: false, status: 413, text: "payload too large" },
    { ok: true, json: { data: [{ embedding: [1, 2] }] } },
  ]);
  const r = await fetchEmbedding("a".repeat(2000), cfg, deps);
  assert.deepEqual(r.vector, [1, 2]);
});

test("missing embedding shape -> null vector with error", async () => {
  const deps = depsReturning([{ ok: true, json: { data: [{}] } }]);
  const r = await fetchEmbedding("x", cfg, deps);
  assert.equal(r.vector, null);
  assert.match(r.error!, /missing data\[0\]\.embedding/);
});

test("http auth error -> null with API error string", async () => {
  const deps = depsReturning([{ ok: false, status: 401, text: "unauthorized" }]);
  const r = await fetchEmbedding("x", cfg, deps);
  assert.equal(r.vector, null);
  assert.match(r.error!, /API 401/);
});

test("empty endpoint returns null vector with no error (wiki parity)", async () => {
  const r = await fetchEmbedding("x", { endpoint: "", model: "m" }, depsReturning([{ ok: true, json: { data: [{ embedding: [1] }] } }]));
  assert.equal(r.vector, null);
  assert.equal(r.error, undefined);
});

test("replaces lone UTF-16 surrogates before sending one text", async () => {
  let sentInput = "";
  const deps: EmbeddingDeps = {
    fetch: async (_url, init) => {
      sentInput = JSON.parse(init.body).input;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
        text: async () => "",
      };
    },
  };

  const r = await fetchEmbedding("valid \ud83d\ude03 broken \ud83d", cfg, deps);

  assert.equal(sentInput, "valid 😃 broken �");
  assert.deepEqual(r.vector, [1, 2, 3]);
});

test("onRetry callback is called once with auto-halve message on 413 then success", async () => {
  const messages: string[] = [];
  const baseDeps = depsReturning([
    { ok: false, status: 413, text: "payload too large" },
    { ok: true, json: { data: [{ embedding: [1, 2] }] } },
  ]);
  const deps: EmbeddingDeps = { ...baseDeps, onRetry: (m) => messages.push(m) };
  const r = await fetchEmbedding("a".repeat(2000), cfg, deps);
  assert.deepEqual(r.vector, [1, 2]);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^auto-halving after HTTP 413/);
});
