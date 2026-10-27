/**
 * `find_files` — locate files on disk for the agent (e.g. to attach to a mail).
 * Uses Spotlight (`mdfind`, instant + system-wide) for the query, then stats
 * and filters the hits. Sensitive paths are dropped from results.
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { basename, extname } from "node:path";
import { expandTilde, isSensitivePath, DEFAULT_TIMEOUT_MS, OUTPUT_CAP } from "./exec.ts";

export interface FindArgs {
  /** Filename substring (Spotlight name match). */
  name?: string;
  /** Free-text Spotlight query (matches name + content + metadata). */
  query?: string;
  /** Restrict the search to a directory subtree. */
  root?: string;
  /** Keep only files with this extension (e.g. "pdf", ".pdf"). */
  extension?: string;
  /** Keep only files modified at/after this ISO date. */
  modifiedAfter?: string;
  limit?: number;
}

export interface FoundFile {
  path: string;
  name: string;
  size: number;
  modified: string;
}

function mdfind(args: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("mdfind", args, { timeout: DEFAULT_TIMEOUT_MS, maxBuffer: OUTPUT_CAP, encoding: "utf8" }, (_err, stdout) => {
      resolve((stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
    });
  });
}

export async function findFiles(a: FindArgs): Promise<FoundFile[]> {
  const limit = Math.min(Math.max(a.limit ?? 50, 1), 500);
  const args: string[] = [];
  if (a.root) args.push("-onlyin", expandTilde(a.root));
  if (a.name) args.push("-name", a.name);
  else if (a.query) args.push(a.query);
  else return []; // need at least a name or a query

  const ext = a.extension ? a.extension.replace(/^\./, "").toLowerCase() : null;
  const after = a.modifiedAfter && Number.isFinite(Date.parse(a.modifiedAfter)) ? Date.parse(a.modifiedAfter) : null;

  const paths = await mdfind(args);
  const out: FoundFile[] = [];
  for (const p of paths) {
    if (out.length >= limit) break;
    if (isSensitivePath(p)) continue;
    if (ext && extname(p).replace(/^\./, "").toLowerCase() !== ext) continue;
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      const modifiedMs = st.mtimeMs;
      if (after && modifiedMs < after) continue;
      out.push({ path: p, name: basename(p), size: st.size, modified: new Date(modifiedMs).toISOString() });
    } catch {
      // vanished / unreadable — skip
    }
  }
  return out;
}
