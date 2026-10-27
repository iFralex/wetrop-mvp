import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashContent, resolveDestination } from "../src/node.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "source-collision-"));
}

test("hashContent is deterministic and content-sensitive", () => {
  assert.equal(hashContent("hello"), hashContent("hello"));
  assert.notEqual(hashContent("hello"), hashContent("world"));
});

test("resolveDestination: write when nothing exists at the destination", () => {
  const dir = tmpDir();
  const result = resolveDestination(join(dir, "report.pdf"), "content", false);
  assert.deepEqual(result, { action: "write", path: join(dir, "report.pdf") });
});

test("resolveDestination: skip when the destination has identical content", () => {
  const dir = tmpDir();
  const path = join(dir, "report.pdf");
  writeFileSync(path, "same");
  const result = resolveDestination(path, "same", false);
  assert.deepEqual(result, { action: "skip", path });
});

test("resolveDestination: overwrite when content differs and isTrackedUpdate is true", () => {
  const dir = tmpDir();
  const path = join(dir, "report.pdf");
  writeFileSync(path, "old");
  const result = resolveDestination(path, "new", true);
  assert.deepEqual(result, { action: "overwrite", path });
});

test("resolveDestination: renames when content differs and isTrackedUpdate is false", () => {
  const dir = tmpDir();
  const path = join(dir, "report.pdf");
  writeFileSync(path, "old");
  const result = resolveDestination(path, "new", false);
  assert.equal(result.action, "rename");
  assert.equal(result.path, join(dir, "report (2).pdf"));
});
