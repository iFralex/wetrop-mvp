import assert from "node:assert/strict";
import { test } from "node:test";
import { decideAction, findAvailablePath } from "../src/index.ts";

test("decideAction: no existing file -> write", () => {
  assert.equal(
    decideAction({ exists: false, newHash: "abc", isTrackedUpdate: false }),
    "write",
  );
});

test("decideAction: identical content -> skip, regardless of tracked-update flag", () => {
  assert.equal(
    decideAction({ exists: true, existingHash: "abc", newHash: "abc", isTrackedUpdate: false }),
    "skip",
  );
  assert.equal(
    decideAction({ exists: true, existingHash: "abc", newHash: "abc", isTrackedUpdate: true }),
    "skip",
  );
});

test("decideAction: different content, tracked update -> overwrite", () => {
  assert.equal(
    decideAction({ exists: true, existingHash: "abc", newHash: "xyz", isTrackedUpdate: true }),
    "overwrite",
  );
});

test("decideAction: different content, not a tracked update -> rename", () => {
  assert.equal(
    decideAction({ exists: true, existingHash: "abc", newHash: "xyz", isTrackedUpdate: false }),
    "rename",
  );
});

test("findAvailablePath: returns the path unchanged when nothing exists there", async () => {
  const result = await findAvailablePath("dir/report.pdf", async () => false);
  assert.equal(result, "dir/report.pdf");
});

test("findAvailablePath: suffixes with (2), (3)... until one is free", async () => {
  const taken = new Set(["dir/report.pdf", "dir/report (2).pdf"]);
  const result = await findAvailablePath("dir/report.pdf", async (candidate) => taken.has(candidate));
  assert.equal(result, "dir/report (3).pdf");
});

test("findAvailablePath: handles filenames with no extension", async () => {
  const taken = new Set(["dir/README"]);
  const result = await findAvailablePath("dir/README", async (candidate) => taken.has(candidate));
  assert.equal(result, "dir/README (2)");
});

test("findAvailablePath: handles a bare filename with no directory", async () => {
  const taken = new Set(["report.pdf"]);
  const result = await findAvailablePath("report.pdf", async (candidate) => taken.has(candidate));
  assert.equal(result, "report (2).pdf");
});
