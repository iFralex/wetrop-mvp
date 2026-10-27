import { realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";
import { isUnreadableSecret } from "@steward/sensitive-path";

export const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".mdx", ".rst", ".log",
  ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml",
  ".xml", ".html", ".htm", ".ics",
]);
export const ARCHIVE_DOCUMENT_EXTENSIONS = new Set([".docx", ".pptx", ".odt"]);
export const SUPPORTED_EXTENSIONS = new Set([".pdf", ".rtf", ...TEXT_EXTENSIONS, ...ARCHIVE_DOCUMENT_EXTENSIONS]);

export interface SafeDocument {
  path: string;
  name: string;
  extension: string;
  size: number;
  modifiedAt: string;
  cacheKey: string;
}

const defaultMaxBytes = 25 * 1024 * 1024;

export function maxDocumentBytes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.DOCUMENT_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? Math.min(Math.floor(configured), 100 * 1024 * 1024) : defaultMaxBytes;
}

export function resolveSafeDocument(input: string, env: NodeJS.ProcessEnv = process.env): SafeDocument {
  if (!input || input.includes("\0")) throw new Error("path is required");
  if (!isAbsolute(input)) throw new Error("path must be absolute");
  if (isUnreadableSecret(input)) throw new Error("path blocked because it may contain secrets");
  let path: string;
  try { path = realpathSync(input); } catch { throw new Error("document not found"); }
  if (isUnreadableSecret(path)) throw new Error("resolved path blocked because it may contain secrets");
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("path is not a regular file");
  const extension = extname(path).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error(`unsupported document type '${extension || "none"}'`);
  }
  const maxBytes = maxDocumentBytes(env);
  if (stat.size > maxBytes) throw new Error(`document is too large (${stat.size} bytes; maximum ${maxBytes})`);
  return {
    path,
    name: basename(path),
    extension,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    cacheKey: `${path}:${stat.size}:${stat.mtimeMs}`,
  };
}
