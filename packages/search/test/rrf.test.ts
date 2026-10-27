import assert from "node:assert/strict";
import { test } from "node:test";
import { rrf } from "../src/rrf.ts";

test("rrf ranks an item appearing in both lists above a single-list item", () => {
  const out = rrf([["a", "x"], ["a", "y"]]);
  assert.equal(out[0].id, "a");
});

test("rrf tiebreak is id descending", () => {
  const out = rrf([["a", "b"], ["b", "a"]]);
  // equal scores -> "b" before "a"
  assert.equal(out[0].id, "b");
});
