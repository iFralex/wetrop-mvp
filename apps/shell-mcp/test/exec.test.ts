import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate, runCommand, runPipeline, runCommandLine, parsePipeline, isSensitivePath, expandTilde, clip, hardenArgs } from "../src/exec.ts";

test("sips is not allowed in read mode (it mutates images in place)", () => {
  assert.match(validate("sips", ["-r", "90", "/tmp/x.jpg"], "read") ?? "", /not allowed|changes files/);
  assert.equal(validate("sips", ["-r", "90", "/tmp/x.jpg"], "write"), null);
});

test("validate: read binary allowed, write binary denied in read mode", () => {
  assert.equal(validate("cat", ["/tmp/x"], "read"), null);
  assert.match(validate("rm", ["/tmp/x"], "read") ?? "", /run_write_command/);
});

test("validate: write mode allows write + read binaries but not others", () => {
  assert.equal(validate("mv", ["/tmp/a", "/tmp/b"], "write"), null);
  assert.equal(validate("cat", ["/tmp/x"], "write"), null); // read binaries ok as pipeline stages
  assert.match(validate("python3", [], "write") ?? "", /not allowed in write/);
});

test("validate: dangerous flags (find -exec/-delete) are rejected", () => {
  assert.match(validate("find", ["/tmp", "-delete"], "read") ?? "", /not allowed/);
  assert.match(validate("find", ["/tmp", "-exec", "rm", "{}", ";"], "read") ?? "", /not allowed/);
});

test("validate: sensitive paths are blocked", () => {
  assert.match(validate("cat", ["/Users/x/.ssh/id_rsa"], "read") ?? "", /sensitive/);
  assert.match(validate("cat", ["~/.aws/credentials"], "read") ?? "", /sensitive/);
  assert.ok(isSensitivePath("/x/Library/Keychains/login.keychain-db"));
  assert.ok(!isSensitivePath("/Users/x/Documents/report.pdf"));
});

test("expandTilde resolves a leading ~/", () => {
  assert.ok(expandTilde("~/Documents").startsWith("/"));
  assert.equal(expandTilde("relative/path"), "relative/path");
});

test("runCommand runs an allowlisted read command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-mcp-"));
  const f = join(dir, "hello.txt");
  writeFileSync(f, "ciao mondo");
  const res = await runCommand("cat", [f], { mode: "read" });
  assert.equal(res.ok, true);
  assert.equal(res.stdout, "ciao mondo");
});

test("runCommand refuses a non-allowlisted binary without spawning it", async () => {
  const res = await runCommand("python3", ["-c", "print(1)"], { mode: "read" });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /not allowed/);
});

test("clip caps lines and reports the total", () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const r = clip(text, 120, 100_000);
  assert.equal(r.clipped, true);
  assert.equal(r.totalLines, 500);
  assert.equal(r.text.split("\n").length, 120);
});

test("runCommand truncates a huge directory listing and hints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-mcp-"));
  for (let i = 0; i < 400; i++) writeFileSync(join(dir, `f${String(i).padStart(3, "0")}.txt`), "x");
  const res = await runCommand("ls", ["-1", dir], { mode: "read" });
  assert.equal(res.ok, true);
  assert.equal(res.truncated, true);
  assert.ok((res.totalLines ?? 0) >= 400);
  assert.ok(res.stdout.split("\n").length <= 120);
  assert.match(res.hint ?? "", /truncated/i);
});

test("runPipeline wires stages: ls -t | head -1 returns the newest entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-mcp-"));
  writeFileSync(join(dir, "old.txt"), "x");
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(dir, "new.txt"), "x");
  const res = await runPipeline([
    { command: "ls", args: ["-t", dir] },
    { command: "head", args: ["-1"] },
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.stdout.trim(), "new.txt");
});

test("runPipeline: grep filter + head compose", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-mcp-"));
  writeFileSync(join(dir, "a.pdf"), "x");
  writeFileSync(join(dir, "b.txt"), "x");
  writeFileSync(join(dir, "c.pdf"), "x");
  const res = await runPipeline([
    { command: "ls", args: ["-1", dir] },
    { command: "grep", args: ["-i", "\\.pdf$"] },
    { command: "wc", args: ["-l"] },
  ]);
  assert.equal(res.ok, true);
  assert.equal(Number(res.stdout.trim()), 2);
});

test("runPipeline validates every stage against the read allowlist", async () => {
  const res = await runPipeline([
    { command: "ls", args: ["/tmp"] },
    { command: "rm", args: ["-rf", "/tmp/x"] },
  ]);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /stage 'rm'.*run_write_command/);
});

test("runPipeline blocks sensitive paths in any stage", async () => {
  const res = await runPipeline([{ command: "cat", args: ["/Users/x/.ssh/id_rsa"] }]);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /sensitive/);
});

test("parsePipeline: words, quotes, and pipe splitting", () => {
  const r = parsePipeline(`ls -t "my dir" | grep -i '\\.pdf$' | head -1`);
  assert.ok("stages" in r);
  if ("stages" in r) {
    assert.deepEqual(r.stages[0], { command: "ls", args: ["-t", "my dir"] });
    assert.deepEqual(r.stages[1], { command: "grep", args: ["-i", "\\.pdf$"] });
    assert.deepEqual(r.stages[2], { command: "head", args: ["-1"] });
  }
});

test("parsePipeline rejects shell operators and empty stages", () => {
  for (const bad of ["cat a; rm b", "cat a > b", "cat a && cat b", "echo `id`", "cat $(whoami)"]) {
    const r = parsePipeline(bad);
    assert.ok("error" in r, `expected error for: ${bad}`);
  }
  assert.ok("error" in parsePipeline("ls | | wc -l"));
  assert.ok("error" in parsePipeline('cat "unbalanced'));
});

test("runCommandLine parses natural syntax: ls -t | head -1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-mcp-"));
  writeFileSync(join(dir, "old.txt"), "x");
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(dir, "new.txt"), "x");
  const res = await runCommandLine(`ls -t ${dir} | head -1`, "read");
  assert.equal(res.ok, true);
  assert.equal(res.stdout.trim(), "new.txt");
});

test("runCommandLine read mode refuses a write binary with a helpful message", async () => {
  const res = await runCommandLine("rm -rf /tmp/whatever", "read");
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /run_write_command/);
});

test("recursive grep is rejected (it can read sensitive files without naming them)", () => {
  assert.match(validate("grep", ["-r", "KEY", "/Users"], "read") ?? "", /recursive/);
  assert.match(validate("grep", ["-R", "KEY", "."], "read") ?? "", /recursive/);
  assert.match(validate("egrep", ["--recursive", "x", "."], "read") ?? "", /recursive/);
});

test("recursive grep is rejected when bundled with other short flags", () => {
  assert.match(validate("grep", ["-rn", "KEY", "/Users"], "read") ?? "", /recursive/);
  assert.match(validate("grep", ["-nr", "KEY", "/Users"], "read") ?? "", /recursive/);
  assert.match(validate("fgrep", ["-Hnr", "KEY", "."], "read") ?? "", /recursive/);
  // Non-recursive combos must keep working.
  assert.equal(validate("grep", ["-in", "KEY", "/tmp/x"], "read"), null);
  assert.equal(validate("grep", ["pattern", "/tmp/file"], "read"), null);
});

test("rg gets sensitive-dir ignore globs injected", () => {
  const out = hardenArgs("rg", ["pattern", "/Users/x"]);
  assert.ok(out.includes("!**/.ssh/**"));
  assert.ok(out.includes("!**/.aws/**"));
});

test("rg descent/include-override flags are rejected (they defeat the injected excludes)", () => {
  for (const args of [["--hidden","P","/tmp"], ["-uu","P","/tmp"], ["-uuu","P","/tmp"], ["--no-ignore","P","/tmp"], ["--iglob","**/known_hosts","P","/tmp"], ["--iglob=**/x","P","/tmp"], ["--","P","/tmp"]]) {
    assert.notEqual(validate("rg", args, "read"), null, `expected rg ${args.join(" ")} to be rejected`);
  }
});

test("plain rg and legit non-recursive grep still pass validate", () => {
  assert.equal(validate("rg", ["PATTERN", "/tmp/docs"], "read"), null);
  assert.equal(validate("grep", ["-in", "x", "/tmp/f"], "read"), null);
  assert.equal(validate("grep", ["-e", "pat", "/tmp/f"], "read"), null);
});

test("grep long-option recursive abbreviations are rejected", () => {
  for (const a of ["--recu", "--recurs", "--recursiv", "--recursive", "--dereference-rec"]) {
    assert.match(validate("grep", [a, "x", "/tmp"], "read") ?? "", /recursive/);
  }
});

test("hardenArgs appends rg excludes AFTER the caller args", () => {
  const out = hardenArgs("rg", ["PATTERN", "/tmp"]);
  assert.equal(out[0], "PATTERN");
  assert.equal(out[1], "/tmp");
  assert.ok(out.slice(2).includes("!**/.ssh/**"));
  assert.ok(out.indexOf("PATTERN") < out.indexOf("!**/.ssh/**"));
});

test("an rg stage inside a pipeline validates and hardens without self-rejecting", async () => {
  const res = await runPipeline([{ command: "rg", args: ["PATTERN", "/tmp"] }, { command: "head", args: ["-1"] }], { mode: "read" });
  // Must not fail with a validation error about the injected !**/.ssh/** globs.
  assert.equal(res.error, undefined);
});

test("grep -d recurse / --directories=recurse are rejected", () => {
  for (const args of [["-d","recurse","x","/tmp"], ["--directories=recurse","x","/tmp"], ["-nd","recurse","x","/tmp"], ["--directories","recurse","x","/tmp"]]) {
    assert.notEqual(validate("grep", args, "read"), null, `expected grep ${args.join(" ")} rejected`);
  }
  // non-directory grep flags still pass
  assert.equal(validate("grep", ["-in","x","/tmp/f"], "read"), null);
  assert.equal(validate("grep", ["-e","pat","/tmp/f"], "read"), null);
});

test("sensitive-path guard is case-insensitive (macOS default FS)", () => {
  assert.match(validate("cat", ["/Users/x/.SSH/config"], "read") ?? "", /sensitive/);
  assert.match(validate("cat", ["/Users/x/report.PEM"], "read") ?? "", /sensitive/);
  assert.match(validate("cat", ["/Library/KEYCHAINS/login.keychain-db"], "read") ?? "", /sensitive/);
});

test("runCommand: shell metacharacters are inert (no shell)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-mcp-"));
  const f = join(dir, "safe.txt");
  writeFileSync(f, "data");
  // The '; rm -rf' is a literal argument to cat, not a shell command.
  const res = await runCommand("cat", [f, "; rm -rf /"], { mode: "read" });
  // cat fails on the bogus filename but nothing is executed/deleted.
  assert.match(res.stdout, /data/);
});
