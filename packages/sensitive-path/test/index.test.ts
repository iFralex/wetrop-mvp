import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnreadableSecret, isServableSecret, isForbiddenWriteDir, RG_IGNORE_GLOBS } from "../src/index.ts";

test("hard secrets are neither readable nor servable (case-insensitive)", () => {
  for (const p of [
    "/Users/x/.ssh/id_rsa", "/Users/x/.SSH/config", "/Users/x/.aws/credentials",
    "/Users/x/.gnupg/secring.gpg", "/Users/x/.netrc", "/Users/x/.git-credentials",
    "/Library/Keychains/login.keychain-db", "/Users/x/Library/Cookies/Cookies.binarycookies",
    "/Users/x/.env", "/Users/x/.env.local", "/Users/x/id_ed25519",
  ]) {
    assert.equal(isUnreadableSecret(p), true, `read should block ${p}`);
    assert.equal(isServableSecret(p), true, `serve should block ${p}`);
  }
});

test("public keys are allowed (read + serve), even inside .ssh", () => {
  for (const p of ["/Users/x/.ssh/id_rsa.pub", "/Users/x/id_ed25519.pub"]) {
    assert.equal(isUnreadableSecret(p), false, `read should allow ${p}`);
    assert.equal(isServableSecret(p), false, `serve should allow ${p}`);
  }
});

test("key-material files: read-blocked but serve-allowed (attach your own cert)", () => {
  for (const p of ["/Users/x/Documents/report.pem", "/Users/x/cert.P12", "/Users/x/id.pfx", "/Users/x/api.key"]) {
    assert.equal(isUnreadableSecret(p), true, `read should block ${p}`);
    assert.equal(isServableSecret(p), false, `serve should allow ${p}`);
  }
});

test("legit files that merely contain 'credentials' in the name are fully allowed", () => {
  for (const p of ["/Users/x/Documents/AWS credentials setup.pdf", "/Users/x/my credentials notes.txt"]) {
    assert.equal(isUnreadableSecret(p), false, `read should allow ${p}`);
    assert.equal(isServableSecret(p), false, `serve should allow ${p}`);
  }
});

test("forbidden write dirs: persistence/system/secret + macOS /private, case-insensitive", () => {
  for (const d of [
    "/Users/x/Library/LaunchAgents", "/Library/LaunchDaemons", "/Users/x/.ssh", "/Users/x/.aws",
    "/etc/cron.d", "/usr/local/bin", "/private/etc/foo", "/private/var/at", "/ETC/cron.d",
    "/Users/x/LIBRARY/LaunchAgents",
  ]) {
    assert.equal(isForbiddenWriteDir(d), true, `should forbid write to ${d}`);
  }
});

test("legit write dirs are allowed, including ~/.config", () => {
  for (const d of ["/Users/x/Documents", "/Users/x/Downloads", "/Users/x/.config/app"]) {
    assert.equal(isForbiddenWriteDir(d), false, `should allow write to ${d}`);
  }
});

test("RG_IGNORE_GLOBS are all negated and cover the key secret dirs/exts", () => {
  assert.ok(RG_IGNORE_GLOBS.every((g) => g.startsWith("!")));
  for (const needle of ["!**/.ssh/**", "!**/.aws/**", "!**/*.pem", "!**/id_rsa", "!**/Cookies/**"]) {
    assert.ok(RG_IGNORE_GLOBS.includes(needle), `missing ${needle}`);
  }
});
