import Database from "@steward/sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { WriteOpsStore } from "@steward/write-ops";
import { ActionStore } from "../../action-center/src/store.ts";
import { recordAudit } from "@steward/audit-log";
import { CompanyScope, initializeScope } from "./scope.ts";

export type Role = "accountant" | "client";
export const statuses = [
  "In progress",
  "Waiting for client",
  "Draft delivered",
  "Awaiting review",
  "Approved",
  "Changes requested",
  "Completed",
  "Failed",
] as const;
export type CaseState = (typeof statuses)[number];
export interface CasePayload {
  request: string;
  state: CaseState;
  period?: string;
  missing: string[];
  results: string[];
  clientVerified?: boolean;
  version: number;
  channel: string;
  lastRequestAt?: number;
  reminders?: number;
  failure?: string;
}
export class Store {
  readonly actions: ActionStore;
  readonly db: Database.Database;
  readonly journal: WriteOpsStore;
  constructor(readonly scope: CompanyScope) {
    initializeScope(scope);
    this.actions = ActionStore.open(
      scope.path(".wetrop/database/actions.db", true),
    );
    this.db = this.actions.raw;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS wetrop_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,hash TEXT NOT NULL,name TEXT NOT NULL,text TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,source TEXT NOT NULL,created INTEGER NOT NULL,case_id INTEGER,version INTEGER NOT NULL DEFAULT 1,approved INTEGER NOT NULL DEFAULT 0,provenance TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS calendar(id TEXT PRIMARY KEY,title TEXT NOT NULL,due TEXT NOT NULL,task TEXT NOT NULL,period TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,lead_days INTEGER NOT NULL DEFAULT 7);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,created INTEGER NOT NULL,case_id INTEGER);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,role TEXT NOT NULL,conversation TEXT NOT NULL,text TEXT NOT NULL,case_id INTEGER,state TEXT NOT NULL DEFAULT 'pending',error TEXT);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created INTEGER NOT NULL,result TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS updates(id INTEGER PRIMARY KEY,state TEXT NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS telegram_requests(message_id INTEGER PRIMARY KEY,case_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings(chat_id TEXT PRIMARY KEY,user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,case_id INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',note TEXT,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,operation TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_operations(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,tool TEXT NOT NULL,state TEXT NOT NULL,result TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS job_leases(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT,expires INTEGER);
    `);
    this.journal = new WriteOpsStore(this.db);
    // Interrupted tool turns can resume. Uncertain external sends must never replay.
  }
  meta<T>(key: string, fallback: T): T {
    const r = this.db
      .prepare("SELECT value FROM wetrop_meta WHERE key=?")
      .get(key) as any;
    return r ? JSON.parse(r.value) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO wetrop_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  audit(type: string, text: string, payload?: unknown) {
    recordAudit({
      actor: "system",
      eventType: `wetrop.${type}`,
      summary: text,
      payload,
    });
  }
  cases() {
    return this.actions.list({ includeDone: true, limit: 100 });
  }
  getCase(id: number) {
    const c = this.actions.get(id);
    if (!c) throw new Error("Practice not found");
    return c;
  }
  payload(id: number): CasePayload {
    return this.getCase(id).payload as unknown as CasePayload;
  }
  createCase(
    request: string,
    channel = "accountant",
    key: string = randomUUID(),
    period?: string,
  ) {
    const out = this.actions.upsert({
      sourceKey: `wetrop:${key}`,
      sourceKind: "company",
      kind: "document-action",
      title: request.slice(0, 100),
      summary: request,
      payload: {
        request,
        state: "In progress",
        missing: [],
        results: [],
        version: 1,
        channel,
        period,
      },
    });
    this.audit("case.created", request, { caseId: out.id });
    return out.id;
  }
  updateCase(id: number, patch: Partial<CasePayload>) {
    const old = this.payload(id);
    if (patch.state && !statuses.includes(patch.state))
      throw new Error("Invalid practice state");
    const payload = { ...old, ...patch };
    if (patch.state && patch.state !== "Failed" && patch.failure === undefined)
      delete payload.failure;
    this.db
      .prepare("UPDATE actions SET payload=?,updated_at=?,status=? WHERE id=?")
      .run(
        JSON.stringify(payload),
        Math.floor(Date.now() / 1000),
        ["Completed", "Approved"].includes(payload.state) ? "done" : "read",
        id,
      );
    this.audit("case.updated", `Practice ${id}: ${payload.state}`, {
      caseId: id,
      patch,
    });
    return payload;
  }
  document(path: string) {
    return this.db
      .prepare("SELECT * FROM documents WHERE path=? OR id=?")
      .get(path, path) as any;
  }
  verifyDocument(document: any) {
    const bytes = readFileSync(this.scope.path(document.path));
    if (createHash("sha256").update(bytes).digest("hex") !== document.hash)
      throw new Error(
        "Document changed since indexing; re-ingest it before delivery or approval",
      );
    return bytes;
  }
  documents() {
    return this.db
      .prepare("SELECT * FROM documents ORDER BY created DESC")
      .all() as any[];
  }
  register(
    path: string,
    source: string,
    text = "",
    caseId?: number,
    provenance: unknown = {},
  ) {
    const bytes = readFileSync(this.scope.path(path));
    const hash = createHash("sha256").update(bytes).digest("hex");
    const existing = this.document(path);
    if (existing) return existing;
    const duplicate = this.db
      .prepare("SELECT * FROM documents WHERE hash=? AND source=?")
      .get(hash, source) as any;
    if (duplicate && source !== "generated") return duplicate;
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO documents(id,path,hash,name,text,status,source,created,case_id,provenance) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        path,
        hash,
        path.split("/").at(-1)!,
        text,
        "indexed",
        source,
        Date.now(),
        caseId ?? null,
        JSON.stringify(provenance),
      );
    this.audit("document.registered", path, { id, caseId });
    return this.document(id);
  }
  message(conversation: string, role: string, text: string, caseId?: number) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO messages VALUES (?,?,?,?,?,?)")
      .run(id, conversation, role, text, Date.now(), caseId ?? null);
    return id;
  }
  enqueue(
    role: Role,
    conversation: string,
    text: string,
    caseId?: number,
    key: string = randomUUID(),
  ) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO jobs(id,role,conversation,text,case_id) VALUES (?,?,?,?,?)",
      )
      .run(key, role, conversation, text, caseId ?? null);
    return key;
  }
  outbox(kind: string, payload: unknown, key: string = randomUUID()) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO outbox(id,kind,payload,created) VALUES (?,?,?,?)",
      )
      .run(key, kind, JSON.stringify(payload), Date.now());
    return key;
  }
  request(id: number, missing: string[]) {
    if (!missing.length) throw new Error("Specify missing information");
    const old = this.payload(id);
    if (
      old.state === "Waiting for client" &&
      JSON.stringify(old.missing) === JSON.stringify(missing)
    )
      return { caseId: id, state: old.state };
    this.updateCase(id, {
      state: "Waiting for client",
      missing,
      lastRequestAt: this.meta<number>("demoNow", Date.now()),
      reminders: 0,
    });
    this.outbox(
      "message",
      {
        text: `Pratica #${id}: ${old.request}\n\nPer completarla servono:\n${missing.map((x) => `• ${x}`).join("\n")}\nRispondi a questo messaggio allegando i documenti o i dati richiesti.`,
        caseId: id,
      },
      `request:${id}:${old.version}:${createHash("sha256").update(JSON.stringify(missing)).digest("hex")}`,
    );
    return { caseId: id, state: "Waiting for client" };
  }
  draft(documentId: string, caseId: number) {
    const doc = this.document(documentId);
    if (!doc || doc.source !== "generated")
      throw new Error("A generated document is required");
    this.verifyDocument(doc);
    const pending = this.db
      .prepare("SELECT id FROM reviews WHERE document_id=?")
      .get(doc.id);
    if (pending) return pending;
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO reviews(id,document_id,case_id,created) VALUES (?,?,?,?)",
      )
      .run(id, doc.id, caseId, Date.now());
    const p = this.payload(caseId);
    this.updateCase(caseId, {
      state: "Awaiting review",
      results: [...new Set([...p.results, doc.path])],
      missing: [],
    });
    this.outbox(
      "document",
      {
        path: doc.path,
        text: `Draft — pending accountant review\nPratica #${caseId}: ${doc.name}`,
        caseId,
      },
      `draft:${doc.id}`,
    );
    return { reviewId: id, path: doc.path, state: "Awaiting review" };
  }
  pair() {
    const code = randomBytes(12).toString("hex");
    this.db
      .prepare("INSERT INTO pairing VALUES (?,?)")
      .run(
        createHash("sha256").update(code).digest("hex"),
        Date.now() + 600000,
      );
    return code;
  }
  bind(code: string, chatId: string, userId: string) {
    return this.db.transaction(() => {
      const h = createHash("sha256").update(code).digest("hex");
      const p = this.db
        .prepare("SELECT * FROM pairing WHERE hash=? AND expires>?")
        .get(h, Date.now());
      if (!p) throw new Error("Invalid or expired pairing code");
      const bound = this.db.prepare("SELECT * FROM bindings").all() as any[];
      if (
        bound.length &&
        !bound.some((x) => x.chat_id === chatId && x.user_id === userId)
      )
        throw new Error("A client is already paired");
      this.db.prepare("DELETE FROM pairing WHERE hash=?").run(h);
      this.db
        .prepare("INSERT OR IGNORE INTO bindings VALUES (?,?)")
        .run(chatId, userId);
      return true;
    })();
  }
  close() {
    this.actions.close();
  }
}
