import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { CompanyScope } from "./scope.ts";
import { Store, type Role, statuses } from "./store.ts";
import { documentTask } from "./documents.ts";
import { graph, searchWiki, updateWiki } from "./wiki.ts";
import { parsePipeline, clip } from "../../shell-mcp/src/exec.ts";
export type Group =
  "action-center" | "calendar" | "documents" | "shell" | "llm-wiki";
const string = { type: "string" };
const number = { type: "number" };
const strings = { type: "array", items: string };
interface Spec {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  accountant?: boolean;
}
const catalog: Record<Group, Spec[]> = {
  "action-center": [
    {
      name: "list_actions",
      description:
        "List company practices with persistent status and pending work.",
      properties: {},
    },
    {
      name: "read_action",
      description: "Read practice, requirements, source documents and results.",
      properties: { id: number },
      required: ["id"],
    },
    {
      name: "create_action",
      description:
        "Create a practice for a request. Reuse the active practice when resuming; do not duplicate.",
      properties: { request: string, period: string },
      required: ["request"],
    },
    {
      name: "request_documents",
      description:
        "Autonomously request missing information from the paired company client. Persists waiting state and resumes after reply.",
      properties: { id: number, missing: strings },
      required: ["id", "missing"],
    },
    {
      name: "update_action",
      description:
        "Update missing information and non-final work status. Approval is reserved to studio UI.",
      properties: {
        id: number,
        state: {
          type: "string",
          enum: [
            "In progress",
            "Waiting for client",
            "Changes requested",
            "Failed",
          ],
        },
        missing: strings,
      },
      required: ["id", "state"],
    },
    {
      name: "deliver_draft",
      description:
        "Send a newly generated document to the paired client as Draft — pending accountant review, and open studio review.",
      properties: { id: number, path: string },
      required: ["id", "path"],
    },
    {
      name: "send_document",
      description:
        "Send an existing original or approved company document to its authorized client. Generated documents require deliver_draft.",
      properties: { path: string, id: number },
      required: ["path"],
    },
    {
      name: "verify_client_data",
      description:
        "Record client confirmation of facts for the active practice, without approving the document as accountant.",
      properties: { id: number },
      required: ["id"],
    },
    {
      name: "complete_collection",
      description:
        "Package selected existing company documents into a ZIP with CSV index and request studio review. No invented missing invoices.",
      properties: { id: number, paths: strings },
      required: ["id", "paths"],
    },
  ],
  calendar: [
    {
      name: "list_calendars",
      description:
        "List the company-local fiscal preparation calendar, never Apple Calendar.",
      properties: {},
    },
    {
      name: "search_events",
      description:
        "Search configured internal deadlines and their task descriptions.",
      properties: { query: string },
    },
    {
      name: "read_event",
      description: "Read a company deadline.",
      properties: { id: string },
      required: ["id"],
    },
    {
      name: "create_event",
      description:
        "Create an internal deadline with an associated task. ISO date including timezone, not a certified fiscal calendar.",
      properties: {
        title: string,
        due: string,
        task: string,
        period: string,
        leadDays: number,
      },
      required: ["title", "due", "task", "period"],
      accountant: true,
    },
    {
      name: "update_event",
      description: "Update an existing deadline and task.",
      properties: {
        id: string,
        title: string,
        due: string,
        task: string,
        enabled: { type: "boolean" },
      },
      required: ["id"],
      accountant: true,
    },
  ],
  documents: [
    {
      name: "document_info",
      description:
        "Inspect supported file, fields, sheets and OCR locations. All paths are company-relative.",
      properties: { path: string },
      required: ["path"],
    },
    {
      name: "document_read",
      description:
        "Read and index company document, with source-backed wiki update. OCR for scans/images.",
      properties: { path: string },
      required: ["path"],
    },
    {
      name: "document_search",
      description:
        "Search indexed company documents by words; returns excerpts and relative paths.",
      properties: { query: string },
      required: ["query"],
    },
    {
      name: "generate_document",
      description:
        "Create or fill DOCX {{fields}} or exact text replacements, XLSX cells, PDF form fields or PDF overlays. Inspect supplied template first. Never invent missing values. For new documents supply title,text,values. Persist field-level source references. Unapproved output is always a draft.",
      properties: {
        title: string,
        format: { type: "string", enum: ["pdf", "docx", "xlsx"] },
        path: string,
        text: string,
        tables: {
          type: "array",
          items: {
            type: "object",
            properties: {
              headers: strings,
              rows: { type: "array", items: strings },
            },
            required: ["headers", "rows"],
            additionalProperties: false,
          },
        },
        replacements: {
          type: "array",
          items: {
            type: "object",
            properties: { find: string, replace: string },
            required: ["find", "replace"],
            additionalProperties: false,
          },
        },
        values: { type: "object", additionalProperties: string },
        sources: { type: "object", additionalProperties: string },
        cells: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sheet: string,
              cell: string,
              value: { type: ["string", "number"] },
            },
            required: ["sheet", "cell", "value"],
            additionalProperties: false,
          },
        },
        overlays: {
          type: "array",
          items: {
            type: "object",
            properties: { page: number, x: number, y: number, value: string },
            required: ["page", "x", "y", "value"],
            additionalProperties: false,
          },
        },
        caseId: number,
      },
      required: ["title", "caseId", "sources"],
    },
    {
      name: "convert_document",
      description:
        "Convert company DOCX/XLSX into a PDF preview using the isolated Office converter. The preview is still a draft.",
      properties: { path: string, caseId: number },
      required: ["path", "caseId"],
    },
    {
      name: "sum_amounts",
      description:
        "Deterministically sum signed euro amounts using integer cents. Return total and cents; no tax computation inferred.",
      properties: { amounts: strings },
      required: ["amounts"],
    },
  ],
  shell: [
    {
      name: "find_files",
      description:
        "Find files only in documents/templates/wiki/exports. No global Spotlight.",
      properties: { name: string, root: string, extension: string },
    },
    {
      name: "run_command",
      description:
        "Bounded read-only company shell. Supported: ls PATH; cat PATH; head PATH; tail PATH; rg QUERY PATH. No arbitrary flags, execution or external paths.",
      properties: { command: string },
      required: ["command"],
    },
    {
      name: "run_write_command",
      description:
        "Request accountant approval for cp SOURCE DEST or mkdir DEST inside working/exports. No original or approved changes, no deletion.",
      properties: { command: string },
      required: ["command"],
      accountant: true,
    },
  ],
  "llm-wiki": [
    {
      name: "llm_wiki_projects",
      description:
        "Return the single company wiki. Other projects cannot be selected.",
      properties: {},
    },
    {
      name: "llm_wiki_files",
      description: "List company wiki pages.",
      properties: {},
    },
    {
      name: "llm_wiki_search",
      description:
        "Search source-backed company knowledge before answering company questions.",
      properties: { query: string, offset: number },
      required: ["query"],
    },
    {
      name: "llm_wiki_read_file",
      description: "Read a company wiki page.",
      properties: { path: string },
      required: ["path"],
    },
    {
      name: "llm_wiki_graph",
      description:
        "Get actual company knowledge graph, documents, practices and deadlines.",
      properties: {},
    },
    {
      name: "llm_wiki_add_source",
      description: "Ingest a company document into the source-backed wiki.",
      properties: { path: string },
      required: ["path"],
    },
    {
      name: "llm_wiki_update_page",
      description:
        "Write a source-backed company wiki page with explicit verification status. Cannot change access controls.",
      properties: {
        name: string,
        title: string,
        text: string,
        sources: strings,
        verified: { type: "boolean" },
      },
      required: ["name", "title", "text", "sources"],
    },
  ],
};
export function tools(group: Group, role: Role) {
  return catalog[group]
    .filter((t) => !t.accountant || role === "accountant")
    .map(({ properties, required, accountant, ...t }) => ({
      ...t,
      inputSchema: {
        type: "object",
        properties,
        required: required ?? [],
        additionalProperties: false,
      },
    }));
}
export async function call(
  store: Store,
  role: Role,
  group: Group,
  name: string,
  a: any,
): Promise<any> {
  if (!tools(group, role).some((t) => t.name === name))
    throw new Error("Tool not allowed for this role");
  // Schema validation is enforced here as well as in the MCP transport.
  const definition = catalog[group].find((t) => t.name === name)!;
  for (const key of definition.required ?? [])
    if (a[key] === undefined) throw new Error(`Missing ${key}`);
  for (const key of Object.keys(a))
    if (!(key in definition.properties))
      throw new Error(`Unexpected argument ${key}`);
  const s = store.scope;
  if (a.projectId !== undefined)
    throw new Error("Project selection is not allowed");
  switch (name) {
    case "list_actions":
      return store.cases();
    case "read_action":
      return store.getCase(a.id);
    case "create_action":
      return { id: store.createCase(a.request, role, randomUUID(), a.period) };
    case "request_documents":
      return store.request(a.id, a.missing);
    case "update_action":
      if (
        ![
          "In progress",
          "Waiting for client",
          "Changes requested",
          "Failed",
        ].includes(a.state)
      )
        throw new Error("Final approval is reserved to the studio");
      return store.updateCase(a.id, {
        state: a.state,
        ...(a.missing ? { missing: a.missing } : {}),
      });
    case "verify_client_data":
      if (role !== "client")
        throw new Error("Only client may attest their data");
      return store.updateCase(a.id, { clientVerified: true });
    case "deliver_draft":
      return store.draft(a.path, a.id);
    case "send_document": {
      const d = store.document(a.path);
      if (!d) throw new Error("Document is not indexed");
      store.verifyDocument(d);
      if (d.source === "generated")
        throw new Error("Generated documents must be delivered as drafts");
      store.outbox("document", {
        path: d.path,
        text: d.name,
        caseId: a.id,
        completePractice: true,
      });
      return { queued: true };
    }
    case "complete_collection": {
      store.getCase(a.id);
      if (!a.paths.length) throw new Error("Select source documents");
      const zip = new JSZip();
      const index = ["File,Source"];
      for (const path of a.paths) {
        const d = store.document(path);
        if (!d || d.source === "generated")
          throw new Error("Select existing source documents");
        zip.file(`${d.id}-${d.name}`, store.verifyDocument(d));
        index.push(
          [d.name, d.path]
            .map((x) => '"' + String(x).replaceAll('"', '""') + '"')
            .join(","),
        );
      }
      zip.file("index.csv", index.join("\n"));
      const path = `exports/collection-${a.id}-${randomUUID()}.zip`;
      writeFileSync(
        s.parent(path),
        await zip.generateAsync({ type: "nodebuffer" }),
        { flag: "wx" },
      );
      const d = store.register(
        path,
        "generated",
        "Collected source documents",
        a.id,
      );
      store.db
        .prepare(
          "INSERT INTO reviews(id,document_id,case_id,created) VALUES (?,?,?,?)",
        )
        .run(randomUUID(), d.id, a.id, Date.now());
      store.updateCase(a.id, {
        state: "Awaiting review",
        results: [...store.payload(a.id).results, path],
        missing: [],
      });
      return { path };
    }
    case "list_calendars":
      return [{ id: "company", name: "Internal preparation deadlines — demo" }];
    case "search_events":
      return store.db
        .prepare(
          "SELECT * FROM calendar WHERE title LIKE ? OR task LIKE ? ORDER BY due",
        )
        .all(`%${a.query ?? ""}%`, `%${a.query ?? ""}%`);
    case "read_event":
      return store.db.prepare("SELECT * FROM calendar WHERE id=?").get(a.id);
    case "create_event": {
      if (
        !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(a.due) ||
        !Number.isFinite(Date.parse(a.due))
      )
        throw new Error("An ISO date with timezone is required");
      const id = randomUUID();
      store.db
        .prepare("INSERT INTO calendar VALUES (?,?,?,?,?,1,?)")
        .run(
          id,
          a.title,
          a.due,
          a.task,
          a.period,
          Math.max(0, Math.min(90, a.leadDays ?? 7)),
        );
      return { id };
    }
    case "update_event": {
      const old = store.db
        .prepare("SELECT * FROM calendar WHERE id=?")
        .get(a.id) as any;
      if (!old) throw new Error("Deadline not found");
      if (a.due && !Number.isFinite(Date.parse(a.due)))
        throw new Error("Invalid date");
      store.db
        .prepare(
          "UPDATE calendar SET title=?,due=?,task=?,enabled=? WHERE id=?",
        )
        .run(
          a.title ?? old.title,
          a.due ?? old.due,
          a.task ?? old.task,
          a.enabled === undefined ? old.enabled : +a.enabled,
          a.id,
        );
      return { updated: true };
    }
    case "document_info":
      return documentTask(s, { operation: "inspect", path: a.path });
    case "document_read":
    case "llm_wiki_add_source": {
      const result = await documentTask(s, {
        operation: "inspect",
        path: a.path,
      });
      const text = result.pages.map((p: any) => p.text).join("\n");
      const doc = store.register(a.path, "company", text);
      updateWiki(store, doc);
      return {
        id: doc.id,
        path: doc.path,
        text: text.slice(0, 40000),
        warnings: result.warnings,
      };
    }
    case "document_search": {
      const terms = String(a.query).toLowerCase().split(/\s+/).filter(Boolean);
      return store
        .documents()
        .map((d) => ({
          id: d.id,
          path: d.path,
          name: d.name,
          status: d.status,
          score: terms.filter((t) =>
            (d.text + " " + d.name).toLowerCase().includes(t),
          ).length,
          snippet: d.text.slice(0, 2000),
        }))
        .filter((d) => d.score)
        .sort((a, b) => b.score - a.score)
        .slice(0, 12);
    }
    case "generate_document": {
      store.getCase(a.caseId);
      for (const ref of Object.values(a.sources ?? {}))
        if (typeof ref === "string" && !ref.startsWith("client:")) s.path(ref);
      const { sources, caseId, ...task } = a;
      const result = await documentTask(s, { ...task, operation: "generate" });
      const d = store.register(result.path, "generated", result.text, caseId, {
        ...result.provenance,
        sources,
      });
      updateWiki(store, d);
      return { ...result, id: d.id };
    }
    case "convert_document": {
      store.getCase(a.caseId);
      const result = await documentTask(s, {
        operation: "convert",
        path: a.path,
      });
      const doc = store.register(
        result.path,
        "generated",
        result.text,
        a.caseId,
        result.provenance,
      );
      return { ...result, id: doc.id };
    }
    case "sum_amounts": {
      let cents = 0;
      for (const amount of a.amounts) {
        if (!/^-?\d+(?:[.,]\d{1,2})?$/.test(amount))
          throw new Error(
            "Amounts must be signed decimals with at most two places",
          );
        const sign = amount.startsWith("-") ? -1 : 1;
        const [whole, fraction = ""] = amount
          .replace("-", "")
          .replace(",", ".")
          .split(".");
        cents += sign * (Number(whole) * 100 + Number(fraction.padEnd(2, "0")));
        if (!Number.isSafeInteger(cents))
          throw new Error("Amount exceeds safe range");
      }
      return { cents, total: (cents / 100).toFixed(2), currency: "EUR" };
    }
    case "find_files":
      return s
        .files(a.root ?? "documents")
        .filter(
          (p) =>
            (!a.name || p.toLowerCase().includes(a.name.toLowerCase())) &&
            (!a.extension || p.endsWith("." + a.extension.replace(/^\./, ""))),
        )
        .slice(0, 100);
    case "run_command": {
      const parsed = parsePipeline(a.command);
      if ("error" in parsed || parsed.stages.length !== 1)
        throw new Error("Use a single company-scoped command");
      const stage = parsed.stages[0];
      const args = stage.args ?? [];
      if (
        !["ls", "cat", "head", "tail", "rg"].includes(stage.command) ||
        args.some((x) => x.startsWith("-"))
      )
        throw new Error("Command or flags not allowed");
      if (stage.command === "rg") {
        if (args.length !== 2) throw new Error("Use rg QUERY ROOT");
        const result = s
          .files(args[1])
          .slice(0, 200)
          .flatMap((path) => {
            if (
              !/\.(md|txt|csv|json)$/.test(path) ||
              statSync(s.path(path)).size > 1048576
            )
              return [];
            return readFileSync(s.path(path), "utf8")
              .split("\n")
              .filter((l) => l.toLowerCase().includes(args[0].toLowerCase()))
              .map((line) => ({ path, line: line.slice(0, 1000) }));
          });
        return result.slice(0, 100);
      }
      if (args.length !== 1)
        throw new Error("Exactly one company-relative path required");
      const p = s.path(args[0]);
      if (stage.command === "ls") return s.files(args[0]);
      if (statSync(p).size > 1048576) throw new Error("Read limit exceeded");
      const text = readFileSync(p, "utf8");
      return clip(
        stage.command === "tail"
          ? text.split("\n").slice(-100).join("\n")
          : text,
        100,
        16000,
      );
    }
    case "run_write_command": {
      const input = parseWrite(s, a.command);
      const id = randomUUID();
      store.db
        .prepare("INSERT INTO approvals VALUES (?,?,?,'pending',?)")
        .run(id, "file.write", JSON.stringify(input), Date.now());
      return {
        approvalId: id,
        state: "pending",
        message: "Awaiting accountant approval in Reviews",
      };
    }
    case "llm_wiki_projects":
      return [{ id: "company", name: "Aurora Servizi S.r.l.", path: "wiki" }];
    case "llm_wiki_files":
      return s.files("wiki/wiki");
    case "llm_wiki_search":
      return searchWiki(store, a.query, a.offset);
    case "llm_wiki_graph":
      return graph(store);
    case "llm_wiki_read_file":
      if (!a.path.startsWith("wiki/wiki/"))
        throw new Error("Only company wiki pages are readable");
      return readFileSync(s.path(a.path), "utf8").slice(0, 40000);
    case "llm_wiki_update_page": {
      if (!/^[a-z0-9-]{1,80}$/.test(a.name))
        throw new Error("Invalid page name");
      if (!a.sources.length)
        throw new Error("Knowledge pages require source references");
      for (const path of a.sources) {
        const full = s.path(path);
        if (!existsSync(full) || !statSync(full).isFile())
          throw new Error("Knowledge source does not exist");
      }
      const path = `wiki/wiki/${a.name}.md`;
      if (a.name === "company")
        throw new Error("Company identity is managed by the studio");
      writeFileSync(
        s.parent(path),
        `---\ntitle: ${JSON.stringify(a.title)}\ntype: entity\nsources:\n${a.sources.map((p: string) => `  - ${p}`).join("\n")}\n---\n# ${a.title}\n\n[[company]]\n\nVerification: ${a.verified ? "confirmed by cited source" : "unverified — needs review"}\n\n${a.text}\n`,
      );
      return { path, graph: graph(store) };
    }
    default:
      throw new Error("Unknown tool");
  }
}
export function parseWrite(scope: CompanyScope, command: string) {
  const p = parsePipeline(command);
  if ("error" in p || p.stages.length !== 1)
    throw new Error("Unsupported write command");
  const { command: op, args = [] } = p.stages[0];
  return validateWrite(scope, { op, args });
}
export function validateWrite(
  scope: CompanyScope,
  operation: { op: string; args: string[] },
) {
  const { op, args } = operation;
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string"))
    throw new Error("Invalid file operation arguments");
  if (
    !["cp", "mkdir"].includes(op) ||
    args.some((a) => a.startsWith("-")) ||
    args.length !== (op === "cp" ? 2 : 1)
  )
    throw new Error("Use cp SOURCE DEST or mkdir DEST");
  const dest = args.at(-1)!;
  if (
    !["documents/working/", "exports/"].some((prefix) =>
      dest.startsWith(prefix),
    )
  )
    throw new Error("Destination must be working/ or exports/");
  scope.path(dest);
  if (op === "cp") scope.path(args[0]);
  return { op, args };
}
export async function startMcp(group: Group) {
  if (!["client", "accountant"].includes(process.env.WETROP_ROLE ?? ""))
    throw new Error("WETROP_ROLE must be explicitly assigned by the host");
  const role = process.env.WETROP_ROLE as Role;
  const store = new Store(new CompanyScope());
  const server = new Server(
    { name: `wetrop-${group}`, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools(group, role),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await call(
        store,
        role,
        group,
        req.params.name,
        req.params.arguments ?? {},
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      store.audit("tool.failed", String(e));
      return {
        isError: true,
        content: [
          { type: "text", text: String(e instanceof Error ? e.message : e) },
        ],
      };
    }
  });
  await server.connect(new StdioServerTransport());
}
