/**
 * The single source of truth for "is this path sensitive?", shared by every
 * connector. Three purpose-aware guards, because the risks differ:
 *  - reading a secret's bytes into the model's context (strict),
 *  - serving/attaching a file locally (narrower — a user may attach their own cert),
 *  - writing an attachment into a system/persistence directory (a different concern).
 * All patterns are case-insensitive (macOS default filesystem is case-insensitive).
 */

/** Genuine secrets: blocked for BOTH reading into context AND local serving. */
const SECRETS = [
  /(^|\/)\.ssh(\/|$)/i,                    // ssh dir: private keys, config, known_hosts
  /(^|\/)\.aws(\/|$)/i,                    // aws creds + SSO token cache
  /(^|\/)\.gnupg(\/|$)/i,                  // gpg keyring
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.netrc$/i,
  /\/Library\/Keychains(\/|$)/i,
  /(^|\/)Cookies(\/|$)/i,                  // browser cookie stores (session tokens)
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,    // PRIVATE ssh keys (…\.pub handled below)
  /(^|\/)\.env(\.[\w-]+)?$/i,              // dotenv secrets
];

/** Key material by extension: additionally blocked for READING (bytes to the
 *  model), but NOT for serving/attaching (that stays the user's call). */
const KEY_MATERIAL = [/\.(pem|p12|pfx|key)$/i];

/** Directories an emailed attachment must never be written into (persistence /
 *  system / secret). `.config` is intentionally NOT here — it is a legit dir. */
const FORBIDDEN_WRITE_DIR = [
  /(^|\/)\.ssh(\/|$)/i, /(^|\/)\.aws(\/|$)/i, /(^|\/)\.gnupg(\/|$)/i,
  /\/Library\/(LaunchAgents|LaunchDaemons|StartupItems|Keychains|Preferences)(\/|$)/i,
  /^\/(etc|usr|bin|sbin|System|var)(\/|$)/i,
  /^\/private\/(etc|var|tmp)(\/|$)/i,
];

/** Public keys are never secret, even inside ~/.ssh (e.g. `cat ~/.ssh/id_rsa.pub`). */
const isPublicKey = (p: string): boolean => /\.pub$/i.test(p);

/** Never read this path's contents into the model's context (shell/find/rg). */
export function isUnreadableSecret(path: string): boolean {
  if (isPublicKey(path)) return false;
  return SECRETS.some((re) => re.test(path)) || KEY_MATERIAL.some((re) => re.test(path));
}

/** Never serve this path over local HTTP / open it as a file card. Narrower than
 *  the read guard: a user may legitimately attach their own cert/credential doc. */
export function isServableSecret(path: string): boolean {
  if (isPublicKey(path)) return false;
  return SECRETS.some((re) => re.test(path));
}

/** True if an attachment must not be written into this directory. */
export function isForbiddenWriteDir(dir: string): boolean {
  return FORBIDDEN_WRITE_DIR.some((re) => re.test(dir));
}

/** rg exclude-globs mirroring the read guard (defense-in-depth: rg recurses into
 *  non-hidden dirs by default, so a non-hidden secret could be stumbled upon). */
export const RG_IGNORE_GLOBS = [
  "!**/.ssh/**", "!**/.aws/**", "!**/.gnupg/**", "!**/Keychains/**", "!**/Cookies/**",
  "!**/.git-credentials", "!**/.netrc",
  "!**/id_rsa", "!**/id_dsa", "!**/id_ecdsa", "!**/id_ed25519",
  "!**/.env", "!**/.env.*", "!**/*.pem", "!**/*.p12", "!**/*.pfx", "!**/*.key",
];
