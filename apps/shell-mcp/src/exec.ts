/**
 * Safe command execution for the shell MCP. No shell is ever spawned
 * (execFile, not exec), so shell metacharacters (| > ; $() ` &&) are inert —
 * they'd be passed as literal argv, never interpreted. Safety = an allowlist of
 * binaries + a denylist of dangerous flags + a sensitive-path guard + output
 * and time caps. Read binaries run freely; write binaries are a separate tool
 * the host gates behind user approval.
 */
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { isUnreadableSecret, RG_IGNORE_GLOBS } from "@steward/sensitive-path";

/** Read-only inspection/search binaries — safe to run without approval. */
export const READ_BINARIES = new Set([
  "ls", "cat", "head", "tail", "file", "stat", "find", "mdfind", "mdls",
  "grep", "egrep", "fgrep", "rg", "wc", "du", "df", "basename", "dirname",
  "realpath", "readlink", "pwd", "sha256sum", "md5", "cksum",
]);

/** Mutating binaries — only via the gated write tool (approval required). */
export const WRITE_BINARIES = new Set(["cp", "mv", "mkdir", "rmdir", "rm", "ln", "touch", "sips"]);

/** Flags that turn an otherwise read-only binary into an executor/mutator. */
const DANGEROUS_FLAGS = new Set([
  "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fdelete",
  "-fprint", "-fprint0", "-fprintf", "-fls",
]);

/** grep-family recursion reads file contents without the paths appearing in argv. */
const GREP_FAMILY = new Set(["grep", "egrep", "fgrep"]);
const RECURSIVE_FLAGS = new Set(["-r", "-R", "--recursive", "--dereference-recursive"]);

/**
 * grep also accepts bundled single-dash short options, e.g. `-rn` (recursive +
 * line numbers) or `-Hnr` — an exact match on `-r`/`-R` alone misses these, and
 * `-rn` is extremely common real-world usage. Flag any single-dash, letters-only
 * (after stripping a trailing numeric argument like `-m5`) cluster containing
 * `r`/`R`; every grep variant uses that letter exclusively for recursion.
 */
function isBundledRecursiveFlag(a: string): boolean {
  if (!a.startsWith("-") || a.startsWith("--")) return false;
  const body = a.slice(1).replace(/\d+$/, "");
  return /^[A-Za-z]+$/.test(body) && /[rR]/.test(body);
}

/** GNU grep accepts unambiguous prefix abbreviations of long options, so
 *  --recu / --recursiv reach recursion just like --recursive. Fail-safe: also
 *  rejects ambiguous short prefixes (grep would reject those itself). */
function isRecursiveLongAbbrev(a: string): boolean {
  if (!a.startsWith("--") || a.length < 4) return false;
  return ["--recursive", "--dereference-recursive"].some((full) => full.startsWith(a));
}

/** rg flags that force reading otherwise-skipped (hidden / git-ignored) files
 *  or re-include specific files, defeating the injected excludes. rg is safe by
 *  default (skips hidden + ignored), where the sensitive dot-dirs live. */
const RG_FORBIDDEN_FLAGS = new Set([
  "--hidden",
  "--unrestricted",
  "--no-ignore", "--no-ignore-dot", "--no-ignore-exclude", "--no-ignore-files",
  "--no-ignore-global", "--no-ignore-parent", "--no-ignore-vcs", "--no-require-git",
  "--iglob",
]);
/** rg -u / -uu / -uuu (unrestricted: progressively disables ignore, hidden, binary). */
const isRgUnrestricted = (a: string): boolean => /^-u+$/.test(a);

/** Inject defensive flags after validation (rg ignore-globs, appended LAST so
 *  they take precedence over any earlier caller -g/--glob). */
export function hardenArgs(binary: string, args: string[]): string[] {
  if (binary !== "rg") return args;
  return [...args, ...RG_IGNORE_GLOBS.flatMap((g) => ["-g", g])];
}

export const OUTPUT_CAP = 1024 * 1024; // 1 MB hard execFile buffer
export const DEFAULT_TIMEOUT_MS = 15_000;
/** How much output is returned to the model by default (keep context small). */
export const DEFAULT_MAX_LINES = 120;
export const DEFAULT_MAX_CHARS = 8_000;

/** Clip text to a line + char budget, so a naive `ls` can't flood the context. */
export function clip(text: string, maxLines: number, maxChars: number): { text: string; clipped: boolean; totalLines: number } {
  const lines = text.split("\n");
  const totalLines = lines.length;
  let clipped = false;
  let out = text;
  if (lines.length > maxLines) { out = lines.slice(0, maxLines).join("\n"); clipped = true; }
  if (out.length > maxChars) { out = out.slice(0, maxChars); clipped = true; }
  return { text: out, clipped, totalLines };
}

/** Expand a leading `~/` (execFile does not do shell tilde expansion). */
export function expandTilde(p: string): string {
  return p.startsWith("~/") || p === "~" ? p.replace(/^~/, homedir()) : p;
}

/** Read-context guard: never read a secret's bytes into the model. */
export function isSensitivePath(value: string): boolean {
  return isUnreadableSecret(expandTilde(value));
}

export type Mode = "read" | "write";

/** Validate a binary + argv for a mode. Returns an error string, or null if OK. */
export function validate(binary: string, args: string[], mode: Mode): string | null {
  // Write mode also permits read binaries (e.g. `find … | … ` feeding a write).
  const allowed = mode === "read" ? READ_BINARIES : new Set([...READ_BINARIES, ...WRITE_BINARIES]);
  if (!allowed.has(binary)) {
    if (mode === "read" && WRITE_BINARIES.has(binary)) {
      return `command '${binary}' changes files — use run_write_command (needs approval), not run_command.`;
    }
    return `command '${binary}' is not allowed in ${mode} mode. Allowed: ${[...allowed].join(", ")}`;
  }
  for (const a of args) {
    if (DANGEROUS_FLAGS.has(a)) return `flag '${a}' is not allowed (it can execute or delete files)`;
    if (GREP_FAMILY.has(binary) && (RECURSIVE_FLAGS.has(a) || isBundledRecursiveFlag(a) || isRecursiveLongAbbrev(a))) {
      return `recursive '${a}' is not allowed for ${binary} (it can read files the path guard never sees). Use find + grep on explicit paths, or rg (which excludes sensitive dirs).`;
    }
    // grep's -d/--directories can enable recursion (`-d recurse`), reading files the
    // path guard never sees. Block the whole option family (fail-safe): -d's only
    // non-recursive values are grep's default anyway.
    if (GREP_FAMILY.has(binary)) {
      const isShortCluster = /^-[a-z]+$/i.test(a); // e.g. -d, -nd, -rd
      const longHead = a.split("=")[0];
      const isDirLong = longHead.startsWith("--") && longHead.length >= 5 && "--directories".startsWith(longHead);
      if ((isShortCluster && /d/i.test(a)) || isDirLong) {
        return `option '${a}' is not allowed for ${binary} (-d/--directories can enable recursion). Use find + grep on explicit paths, or rg.`;
      }
    }
    if (binary === "rg") {
      if (a === "--") return "'--' is not allowed for rg (it would demote the safety excludes to plain paths).";
      const flag = a.split("=")[0];
      if (RG_FORBIDDEN_FLAGS.has(flag) || isRgUnrestricted(a)) {
        return `flag '${a}' is not allowed for rg (it forces reading hidden/ignored files, which can include secrets). Search explicit non-hidden paths instead.`;
      }
    }
    if (isSensitivePath(a)) return `path blocked (sensitive): ${a}`;
  }
  return null;
}

export interface ExecResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True if output was cut (by the line/char budget or the 1 MB buffer). */
  truncated: boolean;
  /** Total stdout lines before clipping (so the model knows how much it missed). */
  totalLines?: number;
  hint?: string;
  error?: string;
}

const clampLines = (n?: number) => Math.min(Math.max(n ?? DEFAULT_MAX_LINES, 1), 5000);
const clampChars = (n?: number) => Math.min(Math.max(n ?? DEFAULT_MAX_CHARS, 200), 200_000);
const fail = (error: string): ExecResult => ({ ok: false, exitCode: null, stdout: "", stderr: "", truncated: false, error });
const TRUNCATE_HINT = "Output truncated. Narrow it (command flags like 'ls -t' / 'find -mtime -N' / 'grep -m N', or a '| head' stage) or raise maxLines only if truly needed.";

/** Run an allowlisted binary with execFile (no shell), capping time + output. */
export function runCommand(
  binary: string,
  args: string[],
  opts: { mode: Mode; cwd?: string; timeoutMs?: number; maxLines?: number; maxChars?: number } = { mode: "read" },
): Promise<ExecResult> {
  const invalid = validate(binary, args, opts.mode);
  if (invalid) return Promise.resolve(fail(invalid));
  const cwd = opts.cwd ? expandTilde(opts.cwd) : undefined;
  if (cwd && isSensitivePath(cwd)) return Promise.resolve(fail(`cwd blocked (sensitive): ${cwd}`));
  const resolvedArgs = hardenArgs(binary, args.map(expandTilde));
  const maxLines = clampLines(opts.maxLines);
  const maxChars = clampChars(opts.maxChars);
  return new Promise<ExecResult>((resolvePromise) => {
    execFile(
      binary, resolvedArgs,
      { cwd, timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: OUTPUT_CAP, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        const bufferOverflow = !!e && String(e.code) === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const timedOut = !!e?.killed;
        const out = clip(stdout ?? "", maxLines, maxChars);
        const truncated = out.clipped || bufferOverflow;
        resolvePromise({
          ok: !e || bufferOverflow,
          exitCode: typeof e?.code === "number" ? e.code : (e ? 1 : 0),
          stdout: out.text,
          stderr: clip(stderr ?? "", 40, 2_000).text,
          truncated,
          totalLines: out.totalLines,
          hint: truncated ? `Showing ${Math.min(maxLines, out.totalLines)} of ${out.totalLines} lines. ${TRUNCATE_HINT}` : undefined,
          error: timedOut ? `timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : (e && !bufferOverflow ? e.message : undefined),
        });
      },
    );
  });
}

export interface Stage { command: string; args?: string[]; }

/**
 * Run a read-only pipeline: stage[i] stdout feeds stage[i+1] stdin, like a shell
 * `|` — but NO shell is used. Each stage is spawned as an allowlisted binary
 * with explicit argv and the streams are wired in Node, so metacharacters stay
 * literal and every stage is validated independently. `head`/`tail` closing
 * early (EPIPE upstream) is normal and ignored.
 */
export function runPipeline(
  stages: Stage[],
  opts: { mode?: Mode; cwd?: string; timeoutMs?: number; maxLines?: number; maxChars?: number } = {},
): Promise<ExecResult> {
  if (!stages.length) return Promise.resolve(fail("pipeline needs at least one stage"));
  if (stages.length > 6) return Promise.resolve(fail("pipeline too long (max 6 stages)"));
  const mode = opts.mode ?? "read";
  // Validate against the pre-hardened args: hardenArgs' own injected ignore-globs
  // (e.g. `!**/.ssh/**`) would otherwise trip validate's sensitive-path check and
  // make rg self-reject. Harden only after validation has passed, for execution.
  const expanded = stages.map((s) => ({ command: s.command, args: (s.args ?? []).map(expandTilde) }));
  for (const s of expanded) {
    const invalid = validate(s.command, s.args, mode);
    if (invalid) return Promise.resolve(fail(`stage '${s.command}': ${invalid}`));
  }
  const norm = expanded.map((s) => ({ command: s.command, args: hardenArgs(s.command, s.args) }));
  const cwd = opts.cwd ? expandTilde(opts.cwd) : undefined;
  if (cwd && isSensitivePath(cwd)) return Promise.resolve(fail(`cwd blocked (sensitive): ${cwd}`));
  const maxLines = clampLines(opts.maxLines);
  const maxChars = clampChars(opts.maxChars);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<ExecResult>((resolvePromise) => {
    const procs = norm.map((s) => spawn(s.command, s.args, { cwd, stdio: ["pipe", "pipe", "pipe"] }));
    let settled = false;
    let outBytes = 0;
    let errBytes = 0;
    let overflow = false;
    let spawnError: string | undefined;
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const finish = (timedOut: boolean, code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* already gone */ } }
      const out = clip(Buffer.concat(outChunks).toString("utf8"), maxLines, maxChars);
      const truncated = out.clipped || overflow;
      resolvePromise({
        ok: !spawnError && !timedOut,
        exitCode: code,
        stdout: out.text,
        stderr: clip(Buffer.concat(errChunks).toString("utf8"), 40, 2_000).text,
        truncated,
        totalLines: out.totalLines,
        hint: truncated ? `Showing ${Math.min(maxLines, out.totalLines)} of ${out.totalLines} lines. ${TRUNCATE_HINT}` : undefined,
        error: spawnError ?? (timedOut ? `timed out after ${timeoutMs}ms` : undefined),
      });
    };
    const timer = setTimeout(() => finish(true, null), timeoutMs);

    // Wire stage i stdout → stage i+1 stdin; swallow EPIPE from early-closing sinks.
    for (let i = 0; i < procs.length - 1; i++) {
      procs[i].stdout?.on("error", () => {});
      procs[i + 1].stdin?.on("error", () => {});
      procs[i].stdout?.pipe(procs[i + 1].stdin!);
    }
    procs[0].stdin?.on("error", () => {});
    procs[0].stdin?.end(); // first stage gets no external input

    const last = procs[procs.length - 1];
    last.stdout?.on("data", (c: Buffer) => {
      if (overflow) return;
      outBytes += c.length;
      if (outBytes > OUTPUT_CAP) { overflow = true; finish(false, null); return; }
      outChunks.push(c);
    });
    for (const p of procs) {
      p.stderr?.on("data", (c: Buffer) => { if (errBytes < 8_000) { errBytes += c.length; errChunks.push(c); } });
      p.on("error", (e: Error) => { spawnError ??= e.message; finish(false, null); });
    }
    last.on("close", (code) => finish(false, code));
  });
}

/**
 * Parse a natural shell-style command line into pipeline stages WITHOUT a shell.
 * Supports: words, single/double quotes, backslash escapes, and `|` between
 * stages. Everything else stays literal — and the genuinely shell-only operators
 * (`;` `&` `<` `>` backtick `$(`) are rejected with a clear message rather than
 * silently mis-behaving. No glob/`$VAR`/substitution expansion happens.
 */
export function parsePipeline(line: string): { stages: Stage[] } | { error: string } {
  const stages: Stage[] = [];
  let tokens: string[] = [];
  let cur = "";
  let hasTok = false;
  let quote: '"' | "'" | null = null;

  const endToken = () => { if (hasTok) { tokens.push(cur); cur = ""; hasTok = false; } };
  const endStage = (): string | null => {
    endToken();
    if (tokens.length === 0) return "empty pipeline stage (a stray '|'?)";
    stages.push({ command: tokens[0], args: tokens.slice(1) });
    tokens = [];
    return null;
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < line.length) { cur += line[++i]; hasTok = true; continue; }
      if (c === quote) { quote = null; hasTok = true; continue; }
      cur += c; hasTok = true; continue;
    }
    if (c === "'" || c === '"') { quote = c; hasTok = true; continue; }
    if (c === "\\" && i + 1 < line.length) { cur += line[++i]; hasTok = true; continue; }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { endToken(); continue; }
    if (c === "|") { const e = endStage(); if (e) return { error: e }; continue; }
    if (c === "$" && line[i + 1] === "(") return { error: "command substitution $(…) is not supported (no shell)." };
    if (c === ";" || c === "&" || c === "<" || c === ">" || c === "`") {
      return { error: `unsupported shell operator '${c}'. Only '|' (pipe) works here — no ; && || > < redirects or backticks.` };
    }
    cur += c; hasTok = true;
  }
  if (quote) return { error: "unbalanced quote in command" };
  const e = endStage();
  if (e) return { error: e };
  if (stages.length === 0) return { error: "empty command" };
  return { stages };
}

/**
 * Run a natural command line (`cmd -a | cmd2 …`): parse it safely into stages
 * then execute via execFile (single) or the wired pipeline (multi). `mode`
 * decides which binaries are allowed (read vs write).
 */
export function runCommandLine(
  line: string,
  mode: Mode,
  opts: { cwd?: string; timeoutMs?: number; maxLines?: number; maxChars?: number } = {},
): Promise<ExecResult> {
  const parsed = parsePipeline(line);
  if ("error" in parsed) return Promise.resolve(fail(parsed.error));
  const { stages } = parsed;
  if (stages.length === 1) return runCommand(stages[0].command, stages[0].args ?? [], { mode, ...opts });
  return runPipeline(stages, { mode, ...opts });
}
