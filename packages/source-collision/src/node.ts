import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, basename, join } from "node:path";
import { decideAction, type CollisionAction } from "./index.ts";

export function hashContent(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface ResolvedDestination {
  action: CollisionAction;
  path: string;
}

/** Node-side synchronous suffix search (kept separate from the async
 * findAvailablePath in ./index.ts so Node callers like wiki-add's applyPlans
 * don't have to become async just to reuse it). */
function findAvailablePathSync(path: string): string {
  if (!existsSync(path)) return path;
  const dir = dirname(path);
  const ext = extname(path);
  const stem = basename(path, ext);
  let i = 2;
  let candidate: string;
  do {
    candidate = join(dir, `${stem} (${i})${ext}`);
    i++;
  } while (existsSync(candidate));
  return candidate;
}

/**
 * Node-only convenience: reads the destination from disk (if present) to
 * decide the action, and (for renames) the actual path to write to. Does
 * not perform the write itself.
 */
export function resolveDestination(
  path: string,
  newContent: Buffer | string,
  isTrackedUpdate: boolean,
): ResolvedDestination {
  const exists = existsSync(path);
  const existingHash = exists ? hashContent(readFileSync(path)) : undefined;
  const newHash = hashContent(newContent);
  const action = decideAction({ exists, existingHash, newHash, isTrackedUpdate });
  if (action === "rename") {
    return { action, path: findAvailablePathSync(path) };
  }
  return { action, path };
}
