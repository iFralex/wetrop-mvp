/**
 * Pure, environment-agnostic collision-decision logic (no Node or browser
 * specific imports) so it can be imported from Node processes and from the
 * Vite/browser frontend alike. Content hashing and disk access are the
 * caller's responsibility — see ./node.ts for a Node convenience wrapper.
 */

export type CollisionAction = "write" | "skip" | "overwrite" | "rename";

export interface DecideActionInput {
  exists: boolean;
  existingHash?: string;
  newHash: string;
  isTrackedUpdate: boolean;
}

/**
 * write: nothing exists at the destination yet.
 * skip: destination exists with byte-identical content — no-op.
 * overwrite: destination exists with different content, but the caller
 *   recognizes this as an update of an origin it already tracks.
 * rename: destination exists with different content and this is *not* a
 *   recognized update — a genuine collision between two unrelated files.
 */
export function decideAction(input: DecideActionInput): CollisionAction {
  if (!input.exists) return "write";
  if (input.existingHash === input.newHash) return "skip";
  if (input.isTrackedUpdate) return "overwrite";
  return "rename";
}

/**
 * Finds the next available "dir/name (2).ext", "dir/name (3).ext"... path
 * when `path` is already taken, probing with the caller-supplied `exists`
 * check (sync or async — works for Node's fs.existsSync wrapped in a
 * resolved promise, or an async Tauri command).
 */
export async function findAvailablePath(
  path: string,
  exists: (candidate: string) => boolean | Promise<boolean>,
): Promise<string> {
  if (!(await exists(path))) return path;
  const lastSlash = path.lastIndexOf("/");
  const dir = lastSlash >= 0 ? path.slice(0, lastSlash) : "";
  const fileName = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  let i = 2;
  let candidate: string;
  do {
    candidate = dir ? `${dir}/${stem} (${i})${ext}` : `${stem} (${i})${ext}`;
    i++;
  } while (await exists(candidate));
  return candidate;
}
