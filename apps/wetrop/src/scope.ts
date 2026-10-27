import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve, relative, sep, dirname, join, isAbsolute } from "node:path";

/** Mandatory boundary shared by every tool and file route. Symlinks are never followed. */
export class CompanyScope {
  readonly root: string;
  constructor(root = process.env.COMPANY_ROOT) {
    if (!root || !isAbsolute(root))
      throw new Error("COMPANY_ROOT must be an absolute path");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(root);
  }
  path(input: string, internal = false): string {
    if (
      typeof input !== "string" ||
      input.includes("\0") ||
      isAbsolute(input) ||
      input.split(/[\\/]/).includes("..")
    )
      throw new Error("Only company-relative paths are allowed");
    const rel = relative(this.root, resolve(this.root, input));
    if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
      throw new Error("Path escapes COMPANY_ROOT");
    if (
      !internal &&
      (rel.split(sep).some((p) => p.startsWith(".")) ||
        !["documents", "templates", "wiki", "exports"].includes(
          rel.split(sep)[0],
        ))
    )
      throw new Error("Private company state is not a document");
    let cursor = this.root;
    for (const part of rel.split(sep).filter(Boolean)) {
      cursor = join(cursor, part);
      if (existsSync(cursor)) {
        const s = lstatSync(cursor);
        if (s.isSymbolicLink() || (s.isFile() && s.nlink > 1))
          throw new Error("Linked paths are not allowed");
        const actual = realpathSync(cursor);
        if (actual !== this.root && !actual.startsWith(this.root + sep))
          throw new Error("Resolved path escapes company");
      }
    }
    return resolve(this.root, rel);
  }
  mkdir(input: string, internal = false) {
    const p = this.path(input, internal);
    mkdirSync(p, { recursive: true, mode: 0o700 });
    return p;
  }
  parent(input: string, internal = false) {
    const p = this.path(input, internal);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    return this.path(input, internal);
  }
  files(root = "documents", limit = 500): string[] {
    const result: string[] = [];
    const walk = (rel: string) => {
      if (result.length >= limit) return;
      for (const item of readdirSync(this.path(rel), { withFileTypes: true })) {
        if (item.name.startsWith(".") || item.isSymbolicLink()) continue;
        const child = `${rel}/${item.name}`;
        if (item.isDirectory()) walk(child);
        else if (item.isFile() && statSync(this.path(child)).nlink === 1)
          result.push(child);
        if (result.length >= limit) break;
      }
    };
    walk(root);
    return result;
  }
}
export const folders = [
  "documents/incoming",
  "documents/originals",
  "documents/working",
  "documents/generated",
  "documents/approved",
  "documents/archive",
  "templates",
  "wiki/raw/sources",
  "wiki/wiki",
  "exports",
  ".wetrop/database",
  ".wetrop/indexes",
  ".wetrop/jobs",
  ".wetrop/audit",
  ".wetrop/cache",
  ".wetrop/tmp",
];
export function initializeScope(scope: CompanyScope) {
  process.env.COMPANY_ROOT = scope.root;
  for (const dir of folders) scope.mkdir(dir, true);
  process.env.AUDIT_DIR = scope.path(".wetrop/audit", true);
  process.env.USAGE_DIR = scope.path(".wetrop/database/usage", true);
  process.env.ACTION_CENTER_DIR = scope.path(".wetrop/database", true);
  process.env.WRITE_OPS_DIR = scope.path(".wetrop/database/write-ops", true);
  process.env.TMPDIR = scope.path(".wetrop/tmp", true);
}
