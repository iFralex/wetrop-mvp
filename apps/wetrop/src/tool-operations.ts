import { createHash } from "node:crypto";
import { Store } from "./store.ts";
const mutations = new Set([
  "create_action",
  "request_documents",
  "update_action",
  "deliver_draft",
  "send_document",
  "verify_client_data",
  "complete_collection",
  "generate_document",
  "convert_document",
  "create_event",
  "update_event",
  "run_write_command",
  "llm_wiki_add_source",
  "llm_wiki_update_page",
]);
function stable(value: any): any {
  return Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;
}
/** Keep external effects idempotent across SDK retries and broker restarts. */
export async function executeToolOnce<T>(
  store: Store,
  jobId: string,
  tool: string,
  input: unknown,
  execute: () => Promise<T>,
): Promise<T> {
  if (!mutations.has(tool.split("__").at(-1)!)) return execute();
  const key = createHash("sha256")
    .update(jobId + "\n" + tool + "\n" + JSON.stringify(stable(input)))
    .digest("hex");
  const previous = store.db
    .prepare("SELECT * FROM tool_operations WHERE id=?")
    .get(key) as any;
  if (previous?.state === "completed") return JSON.parse(previous.result);
  if (previous)
    throw new Error(
      `Tool operation ${key.slice(0, 12)} ${previous.state === "failed" ? "failed with these exact arguments; correct the arguments" : "has an uncertain outcome; inspect Activity before explicitly starting a new request"}`,
    );
  if (
    store.db
      .prepare(
        "SELECT 1 FROM tool_operations WHERE job_id=? AND state IN ('started','unknown')",
      )
      .get(jobId)
  )
    throw new Error(
      "A previous tool operation has an uncertain outcome; inspect it before issuing further writes",
    );
  store.db
    .prepare(
      "INSERT INTO tool_operations(id,job_id,tool,state) VALUES (?,?,?,'started')",
    )
    .run(key, jobId, tool);
  try {
    const result = await execute();
    store.db
      .prepare(
        "UPDATE tool_operations SET state='completed',result=? WHERE id=?",
      )
      .run(JSON.stringify(result), key);
    return result;
  } catch (e) {
    store.db
      .prepare("UPDATE tool_operations SET state=?,error=? WHERE id=?")
      .run(
        (e as any)?.name === "McpToolError" ? "failed" : "unknown",
        e instanceof Error ? e.message : "Tool failed",
        key,
      );
    throw e;
  }
}
