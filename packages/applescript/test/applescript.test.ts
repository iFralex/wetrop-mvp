import assert from "node:assert/strict";
import { test } from "node:test";
import { esc, runOsa } from "../src/index.ts";

test("esc escapes backslashes and quotes", () => {
  assert.equal(esc('a"b\\c'), 'a\\"b\\\\c');
});

test("runOsa returns stdout from the injected exec", async () => {
  const out = await runOsa("script", { exec: async () => "hello\n" });
  assert.equal(out, "hello\n");
});

test("runOsa retries once on a transient error then succeeds", async () => {
  let calls = 0;
  const out = await runOsa("s", {
    exec: async () => {
      calls++;
      if (calls === 1) throw new Error("connection is invalid (-609)");
      return "ok";
    },
  });
  assert.equal(out, "ok");
  assert.equal(calls, 2);
});

test("runOsa fires onStall once an attempt is still pending past half of timeoutMs, then keeps waiting for it", async () => {
  let stallCount = 0;
  let resolveExec!: (v: string) => void;
  const pending = runOsa("s", {
    timeoutMs: 40,
    onStall: () => { stallCount += 1; },
    exec: () => new Promise((resolve) => { resolveExec = resolve; }),
  });
  await new Promise((r) => setTimeout(r, 30)); // past half (20ms), before full (40ms)
  assert.equal(stallCount, 1);
  resolveExec("done");
  assert.equal(await pending, "done");
  assert.equal(stallCount, 1, "must not fire again after the attempt already settled");
});

test("runOsa does not fire onStall when the attempt finishes before half of timeoutMs", async () => {
  let stalled = false;
  const out = await runOsa("s", {
    timeoutMs: 1000,
    onStall: () => { stalled = true; },
    exec: async () => "fast",
  });
  assert.equal(out, "fast");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stalled, false);
});

test("runOsa maps a non-transient error via mapError and does not retry", async () => {
  let calls = 0;
  await assert.rejects(
    runOsa("s", {
      exec: async () => { calls++; throw new Error("-1743 Not authorized"); },
      mapError: () => "AUTOMATION_BLOCKED",
    }),
    /AUTOMATION_BLOCKED/,
  );
  assert.equal(calls, 1);
});
