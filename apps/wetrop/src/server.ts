import { DatabaseBridge } from "../../../packages/sqlite/src/bridge.ts";
import { JobRunner } from "./jobs.ts";
import { ChatGPTAuth } from "./chatgpt-auth.ts";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  readFileSync,
  existsSync,
  copyFileSync,
  writeFileSync,
  createReadStream,
  statSync,
  rmSync,
} from "node:fs";
import { resolve, extname } from "node:path";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { localScope, accessToken, projectRoot, runtimePath } from "./setup.ts";
import { Store } from "./store.ts";
import { Automation } from "./automation.ts";
import { Agent } from "./agent.ts";
import { Telegram } from "./telegram.ts";
import { seedDemo } from "./seed.ts";
import { graph } from "./wiki.ts";
import { validateWrite } from "./mcp.ts";
import { Scheduler } from "../../scheduler/src/scheduler.ts";
import { auditLog } from "@steward/audit-log";
import { usageLedger } from "@steward/usage-ledger";
async function body(req: IncomingMessage, limit = 1024 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request exceeds size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function approveReview(
  s: Store,
  id: string,
  decision: string,
  note = "",
) {
  if (!["approve", "changes", "reject"].includes(decision))
    throw new Error("Invalid review decision");
  return s.db.transaction(() => {
    const r = s.db.prepare("SELECT * FROM reviews WHERE id=?").get(id) as any;
    if (!r || r.state !== "pending") throw new Error("Review is not pending");
    const d = s.document(r.document_id);
    if (!d) throw new Error("Document not found");
    s.verifyDocument(d);
    if (decision === "approve") {
      const operation = s.journal.start({
        kind: "document.publish",
        input: { documentId: d.id, review: id },
        expected: { approved: true },
      });
      const path = `documents/approved/${d.id}-${d.name}`;
      copyFileSync(s.scope.path(d.path), s.scope.parent(path), 1);
      const approved = s.register(path, "approved", d.text, r.case_id, {
        source: d.path,
        review: id,
      });
      s.db
        .prepare("UPDATE documents SET approved=1 WHERE id=?")
        .run(approved.id);
      s.journal.markConfirmed(operation, { path });
      s.db
        .prepare("UPDATE reviews SET state='approved',note=? WHERE id=?")
        .run(note, id);
      s.updateCase(r.case_id, {
        state: "Approved",
        results: [...s.payload(r.case_id).results, path],
      });
      s.outbox(
        "document",
        {
          path,
          text: `Approved by the accountant\nPratica #${r.case_id}: ${d.name}`,
          caseId: r.case_id,
        },
        `approval:${id}`,
      );
    } else {
      s.db
        .prepare("UPDATE reviews SET state=?,note=? WHERE id=?")
        .run(decision, note, id);
      s.updateCase(r.case_id, { state: "Changes requested" });
      s.outbox(
        "message",
        {
          text: `Pratica #${r.case_id}: lo studio ha richiesto una revisione. ${note}`,
          caseId: r.case_id,
        },
        `review:${id}:${decision}`,
      );
      if (decision === "changes" && note)
        s.enqueue(
          "accountant",
          "studio",
          `Revise the draft ${d.path}, preserving the previous version. Accountant feedback: ${note}. Generate a new version and deliver it as a draft for a new review.`,
          r.case_id,
          `revision:${id}`,
        );
    }
    s.audit("review.decided", `Studio review: ${decision}`, {
      reviewId: id,
      note,
    });
    return { ok: true };
  })();
}
export async function startServer() {
  const scope = localScope();
  const pidPath = scope.parent(".wetrop/jobs/broker.pid", true);
  if (existsSync(pidPath)) {
    const previous = Number(readFileSync(pidPath, "utf8"));
    try {
      process.kill(previous, 0);
      throw new Error("Wetrop is already running");
    } catch (e) {
      if ((e as any).code !== "ESRCH") throw e;
      rmSync(pidPath);
    }
  }
  writeFileSync(pidPath, String(process.pid), { flag: "wx", mode: 0o600 });
  const s = new Store(scope);
  await seedDemo(s);
  const databaseBridge = new DatabaseBridge(s.scope.root).start();
  const token = accessToken();
  const streams = new Set<ServerResponse>();
  const emit = (e: any) => {
    for (const res of streams) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  const chatgpt = new ChatGPTAuth();
  const agent = new Agent(s, emit),
    telegram = new Telegram(s),
    automation = new Automation(s);
  s.db
    .prepare(
      "UPDATE outbox SET state='unknown',error='Interrupted during delivery; verify before any new send' WHERE state='sending'",
    )
    .run();
  s.db.prepare("UPDATE jobs SET state='pending' WHERE state='running'").run();
  const runner = new JobRunner(s, agent, emit);
  const processJobs = async () => {
    await runner.next();
  };
  const scheduler = new Scheduler(
    [
      { name: "agent-jobs", everyMs: 1000, run: processJobs },
      { name: "telegram-inbound", everyMs: 2500, run: () => telegram.poll() },
      {
        name: "telegram-outbound",
        everyMs: 1500,
        run: () => telegram.deliver(),
      },
      {
        name: "company-deadlines",
        everyMs: 30000,
        run: () => automation.tick(),
      },
    ],
    {
      log: (line) => {
        if (line.includes("FAILED")) console.error(line);
      },
    },
  );
  const json = (res: ServerResponse, value: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? "/", "http://wetrop.local");
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host)
        return json(res, { error: "Cross-origin request denied" }, 403);
      if (u.pathname.startsWith("/api/")) {
        const candidate =
          req.headers.authorization?.replace(/^Bearer /, "") ?? "";
        const a = Buffer.from(candidate),
          b = Buffer.from(token);
        if (a.length !== b.length || !timingSafeEqual(a, b))
          return json(res, { error: "Access key required" }, 401);
        if (req.method === "GET" && u.pathname === "/api/events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          });
          res.write(": connected\n\n");
          streams.add(res);
          req.on("close", () => streams.delete(res));
          return;
        }
        if (req.method === "GET" && u.pathname === "/api/state")
          return json(res, {
            company: s.meta("company", {}),
            cases: s.cases(),
            documents: s.documents().map(({ text, ...d }) => d),
            calendar: s.db.prepare("SELECT * FROM calendar ORDER BY due").all(),
            reviews: s.db
              .prepare(
                "SELECT r.*,d.path,d.name FROM reviews r JOIN documents d ON d.id=r.document_id ORDER BY r.created DESC",
              )
              .all(),
            approvals: s.db
              .prepare("SELECT * FROM approvals ORDER BY created DESC")
              .all(),
            jobs: s.db
              .prepare("SELECT * FROM jobs ORDER BY rowid DESC LIMIT 30")
              .all(),
            toolOperations: s.db
              .prepare(
                "SELECT id,job_id,tool,state,error FROM tool_operations ORDER BY rowid DESC LIMIT 50",
              )
              .all(),
            deliveries: s.db
              .prepare(
                "SELECT id,kind,state,created,error FROM outbox ORDER BY created DESC LIMIT 30",
              )
              .all(),
            messages: s.db
              .prepare("SELECT * FROM messages ORDER BY created DESC LIMIT 150")
              .all()
              .reverse(),
            graph: graph(s),
            paired: !!s.db.prepare("SELECT 1 FROM bindings LIMIT 1").get(),
            telegramConfigured: telegram.configured,
            chatgpt: chatgpt.status(),
            modelConfigured:
              (chatgpt.status().connected && !!chatgpt.status().model) ||
              (!!process.env.WETROP_MODEL_URL && !!process.env.WETROP_MODEL),
            demoNow: s.meta("demoNow", Date.now()),
            activity: auditLog().query({ limit: 50 }),
            usage: usageLedger().summary(),
          });
        if (req.method === "GET" && u.pathname === "/api/file") {
          const path = u.searchParams.get("path") ?? "";
          const full = s.scope.path(path);
          const indexed = s.document(path);
          if (indexed) s.verifyDocument(indexed);
          const allowed =
            indexed ||
            path.startsWith("templates/") ||
            path.startsWith("wiki/wiki/");
          if (!allowed) throw new Error("File is not registered");
          const mime: Record<string, string> = {
            ".pdf": "application/pdf",
            ".docx":
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".xlsx":
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ".zip": "application/zip",
            ".csv": "text/csv",
            ".md": "text/plain",
          };
          res.writeHead(200, {
            "Content-Type": mime[extname(path)] ?? "application/octet-stream",
            "Content-Disposition": `attachment; filename="${path
              .split("/")
              .at(-1)!
              .replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
            "Cache-Control": "no-store",
          });
          createReadStream(full).pipe(res);
          return;
        }
        if (req.method === "POST" && u.pathname === "/api/upload") {
          const raw = await body(req, 25 * 1024 * 1024);
          const name = String(req.headers["x-filename"] ?? "attachment.bin")
            .replace(/[^a-zA-Z0-9._-]/g, "_")
            .slice(-100);
          const path = `documents/originals/${randomUUID()}-${name}`;
          writeFileSync(s.scope.parent(path), raw, { flag: "wx", mode: 0o600 });
          s.enqueue(
            "accountant",
            "studio",
            `Ingest this uploaded company file: ${path}. Inspect and index it in the company wiki. Do not send it to anyone unless requested.`,
          );
          return json(res, { path });
        }
        if (req.method === "POST") {
          const input = JSON.parse((await body(req)).toString() || "{}");
          if (u.pathname === "/api/chatgpt/login") {
            const flow = await chatgpt.start(input.accountId);
            return json(res, { url: flow.url });
          }
          if (u.pathname === "/api/chatgpt/models")
            return json(res, { models: await chatgpt.models() });
          if (u.pathname === "/api/chatgpt/model") {
            await chatgpt.selectModel(String(input.model));
            return json(res, { ok: true });
          }
          if (u.pathname === "/api/chatgpt/account") {
            await chatgpt.activate(String(input.accountId));
            return json(res, { ok: true });
          }
          if (u.pathname === "/api/chatgpt/logout")
            return json(res, await chatgpt.logout());
          if (u.pathname === "/api/chat") {
            if (
              typeof input.text !== "string" ||
              !input.text.trim() ||
              input.text.length > 30000
            )
              throw new Error("Message must contain 1–30000 characters");
            const id =
              input.caseId === undefined ? undefined : Number(input.caseId);
            if (id !== undefined) s.getCase(id);
            s.message("studio", "accountant", input.text, id);
            return json(res, {
              jobId: s.enqueue("accountant", "studio", input.text, id),
            });
          }
          if (u.pathname === "/api/pair")
            return json(res, { code: s.pair(), expiresInSeconds: 600 });
          if (u.pathname === "/api/review")
            return json(
              res,
              approveReview(
                s,
                String(input.id),
                String(input.decision),
                String(input.note ?? ""),
              ),
            );
          if (u.pathname === "/api/retry-job") {
            const job = s.db
              .prepare("SELECT * FROM jobs WHERE id=? AND state='failed'")
              .get(String(input.id)) as any;
            if (!job) throw new Error("Failed job not found");
            s.db
              .prepare("UPDATE jobs SET state='pending',error=NULL WHERE id=?")
              .run(job.id);
            return json(res, { ok: true });
          }
          if (u.pathname === "/api/clock") {
            const now = Date.parse(input.now);
            if (!Number.isFinite(now))
              throw new Error("An ISO demo date is required");
            s.set("demoNow", now);
            await automation.tick();
            return json(res, { now });
          }
          if (u.pathname === "/api/deadline") {
            const event = s.db
              .prepare("SELECT * FROM calendar WHERE id=?")
              .get(String(input.id)) as any;
            if (!event) throw new Error("Deadline not found");
            if (
              input.due !== undefined &&
              !Number.isFinite(Date.parse(input.due))
            )
              throw new Error("Invalid deadline date");
            s.db
              .prepare("UPDATE calendar SET due=?,task=?,enabled=? WHERE id=?")
              .run(
                input.due ?? event.due,
                input.task ?? event.task,
                input.enabled === undefined ? event.enabled : +!!input.enabled,
                event.id,
              );
            return json(res, { ok: true });
          }
          if (u.pathname === "/api/file-approval") {
            const row = s.db
              .prepare("SELECT * FROM approvals WHERE id=? AND state='pending'")
              .get(String(input.id)) as any;
            if (!row) throw new Error("Approval not pending");
            if (input.allow) {
              const p = JSON.parse(row.input);
              const checked = validateWrite(s.scope, p);
              if (checked.op === "cp")
                copyFileSync(
                  s.scope.path(checked.args[0]),
                  s.scope.parent(checked.args[1]),
                  1,
                );
              else s.scope.mkdir(checked.args[0]);
            }
            s.db
              .prepare("UPDATE approvals SET state=? WHERE id=?")
              .run(input.allow ? "approved" : "denied", row.id);
            return json(res, { ok: true });
          }
        }
        return json(res, { error: "Not found" }, 404);
      }
      const dist = resolve(projectRoot, "apps/web/dist");
      const path =
        u.pathname === "/"
          ? "index.html"
          : decodeURIComponent(u.pathname).replace(/^\//, "");
      if (path.split("/").includes(".."))
        return json(res, { error: "Not found" }, 404);
      let full = resolve(dist, path);
      if (!full.startsWith(dist + "/"))
        return json(res, { error: "Not found" }, 404);
      if (!existsSync(full) || !statSync(full).isFile())
        full = resolve(dist, "index.html");
      if (!existsSync(full))
        return json(
          res,
          { error: "Build the UI with npm run wetrop:build" },
          503,
        );
      const mime: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".png": "image/png",
      };
      res.writeHead(200, {
        "Content-Type": mime[extname(full)] ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      createReadStream(full).pipe(res);
    } catch (e) {
      if (!res.headersSent)
        json(
          res,
          { error: e instanceof Error ? e.message : "Request failed" },
          400,
        );
      else res.end();
    }
  });
  const port = Number(process.env.WETROP_PORT ?? 4417);
  await new Promise<void>((r) => server.listen(port, "0.0.0.0", r));
  scheduler.start();
  console.log(
    `Wetrop: http://localhost:${port}\nAccess key is stored in ${resolve(projectRoot, ".runtime/access-token")}\nCompany data: ${s.scope.root}\nTelegram: ${telegram.configured ? "configured" : "not configured"}`,
  );
  const close = async () => {
    scheduler.stop();
    chatgpt.close();
    rmSync(pidPath, { force: true });
    for (const stream of streams) stream.end();
    await agent.close();
    automation.close();
    databaseBridge.close();
    s.close();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { server, store: s, close };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  startServer()
    .then(({ close }) => {
      for (const signal of ["SIGINT", "SIGTERM"])
        process.once(signal, () => {
          void close().then(() => process.exit(0));
        });
    })
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
}
