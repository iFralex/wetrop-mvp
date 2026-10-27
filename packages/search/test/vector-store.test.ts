import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { VectorStore } from "../src/vector-store.ts";

function makeStore() {
  const raw = new Database(":memory:");
  const state = new Map<string, string>();
  const vs = new VectorStore(raw, {
    table: "vec_items",
    getState: (k) => state.get(k),
    setState: (k, v) => void state.set(k, v),
  });
  return { raw, vs };
}

test("VectorStore upserts and KNN returns nearest rowid first", () => {
  const { vs } = makeStore();
  assert.equal(vs.enable(), true);
  vs.ensureTable(3);
  vs.upsert(1, [1, 0, 0]);
  vs.upsert(2, [0, 1, 0]);
  const hits = vs.knn([0.9, 0.1, 0], 2);
  assert.equal(hits[0].rowid, 1);
});

test("ensureTable at a new dim drops old vectors", () => {
  const { vs, raw } = makeStore();
  vs.enable();
  vs.ensureTable(3);
  vs.upsert(1, [1, 0, 0]);
  vs.ensureTable(4); // dim change
  const n = (raw.prepare("SELECT COUNT(*) c FROM vec_items").get() as { c: number }).c;
  assert.equal(n, 0);
});
