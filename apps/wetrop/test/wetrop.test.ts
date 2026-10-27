import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  linkSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import { CompanyScope } from "../src/scope.ts";
import { Store } from "../src/store.ts";
import { processDocument, documentTask } from "../src/documents.ts";
import { call, tools } from "../src/mcp.ts";
import { Automation } from "../src/automation.ts";
import { Telegram } from "../src/telegram.ts";
import { seedDemo } from "../src/seed.ts";
import { approveReview } from "../src/server.ts";
import { graph, searchWiki } from "../src/wiki.ts";
import { projectRoot, localScope } from "../src/setup.ts";
const base = join(projectRoot, ".runtime/tests");
mkdirSync(base, { recursive: true });
const testRoot = mkdtempSync(join(base, "suite-"));
const all: Store[] = [];
function fixture() {
  const scope = new CompanyScope(mkdtempSync(join(testRoot, "company-")));
  const s = new Store(scope);
  all.push(s);
  return s;
}
after(() => {
  for (const s of all) s.close();
  rmSync(testRoot, { recursive: true, force: true });
});
test("all document tools reject absolute paths, traversal and internal configuration", () => {
  const s = fixture();
  for (const path of [
    "/etc/passwd",
    "../outside",
    "documents/../../outside",
    ".wetrop/database/actions.db",
    "wiki/../secrets",
    "documents/evil\0.pdf",
  ])
    assert.throws(() => s.scope.path(path));
  assert.doesNotThrow(() => s.scope.path("wiki/wiki/company.md"));
});
test("symlink and hardlink escapes are rejected for reads and new writes", () => {
  const s = fixture();
  const outside = join(testRoot, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret"), "private");
  symlinkSync(outside, s.scope.path("documents/escape"));
  assert.throws(() => s.scope.path("documents/escape/secret"));
  assert.throws(() => s.scope.parent("documents/escape/new.txt"));
  linkSync(join(outside, "secret"), s.scope.path("documents/hardlink"));
  assert.throws(() => s.scope.path("documents/hardlink"));
});
test("local configuration cannot point company files outside the Wetrop checkout", () => {
  const old = process.env.COMPANY_ROOT;
  process.env.COMPANY_ROOT = "/tmp/wetrop-forbidden-root";
  try {
    assert.throws(() => localScope(), /inside this Wetrop/);
    assert.equal(existsSync("/tmp/wetrop-forbidden-root"), false);
  } finally {
    if (old) process.env.COMPANY_ROOT = old;
    else delete process.env.COMPANY_ROOT;
  }
});
test("company data and calendar seeded once, knowledge has real graph and sources", async () => {
  const s = fixture();
  await seedDemo(s);
  await seedDemo(s);
  assert.equal(s.meta<any>("company", {}).name, "Aurora Servizi S.r.l.");
  assert.equal(
    (s.db.prepare("SELECT COUNT(*) n FROM calendar").get() as any).n,
    6,
  );
  assert.ok(searchWiki(s, "Energia").results.length);
  const g = graph(s);
  assert.ok(
    g.edges.some(
      (e) => e.source === "company" && e.target === "supplier-energia",
    ),
  );
  assert.ok(s.scope.files("templates").some((p) => p.endsWith(".docx")));
});
test("client tools cannot edit fiscal calendar or execute file mutations", async () => {
  const s = fixture();
  assert.equal(
    tools("calendar", "client").some((t) => t.name === "create_event"),
    false,
  );
  await assert.rejects(
    () => call(s, "client", "calendar", "create_event", { title: "x" }),
    /not allowed/,
  );
  await assert.rejects(
    () =>
      call(s, "client", "shell", "run_write_command", {
        command: "mkdir documents/working/a",
      }),
    /not allowed/,
  );
  await assert.rejects(
    () =>
      call(s, "client", "action-center", "update_action", {
        id: s.createCase("x"),
        state: "Approved",
      }),
    /reserved/,
  );
});
test("scoped shell reuses parser but blocks global commands, pipes and flags", async () => {
  const s = fixture();
  writeFileSync(
    s.scope.parent("documents/originals/sample.txt"),
    "invoice sample",
  );
  const result = await call(s, "accountant", "shell", "run_command", {
    command: "cat documents/originals/sample.txt",
  });
  assert.match(
    result.stdout ?? result.text ?? JSON.stringify(result),
    /invoice sample/,
  );
  for (const cmd of [
    "cat /etc/passwd",
    "cat ../outside",
    "ls .wetrop",
    "find /",
    "cat documents/originals/sample.txt | sh",
    "rg --files /",
    "cat $(pwd)",
  ])
    await assert.rejects(() =>
      call(s, "accountant", "shell", "run_command", { command: cmd }),
    );
});
test("money totals use integer cents", async () => {
  const s = fixture();
  assert.deepEqual(
    await call(s, "client", "documents", "sum_amounts", {
      amounts: ["0.10", "0.20", "-0.03"],
    }),
    { cents: 27, total: "0.27", currency: "EUR" },
  );
  await assert.rejects(() =>
    call(s, "client", "documents", "sum_amounts", { amounts: ["1.234"] }),
  );
});
test("PDF generation and worker extraction retain readable draft content", async () => {
  const s = fixture();
  const d = await documentTask(s.scope, {
    operation: "generate",
    format: "pdf",
    title: "Test summary",
    text: "Total EUR 122.00",
  });
  assert.match(d.text, /122.00/);
  assert.equal(d.draft, true);
  assert.ok(existsSync(s.scope.path(d.path)));
  await assert.rejects(() =>
    documentTask(s.scope, { operation: "inspect", path: "../not-company" }),
  );
});
test("PDF form fields are filled without modifying original", async () => {
  const s = fixture();
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  pdf
    .getForm()
    .createTextField("company")
    .addToPage(page, { x: 50, y: 600, width: 300, height: 30 });
  const bytes = await pdf.save();
  const path = "templates/form.pdf";
  writeFileSync(s.scope.parent(path), bytes);
  const result = await processDocument(s.scope, {
    operation: "generate",
    path,
    title: "Filled form",
    values: { company: "Aurora Servizi" },
  });
  const filled = await PDFDocument.load(
    readFileSync(s.scope.path(result.path)),
  );
  assert.equal(
    filled.getForm().getTextField("company").getText(),
    "Aurora Servizi",
  );
  assert.deepEqual(readFileSync(s.scope.path(path)), Buffer.from(bytes));
});
test("static PDF overlays are validated and actually applied", async () => {
  const s = fixture();
  const pdf = await PDFDocument.create();
  pdf.addPage();
  writeFileSync(s.scope.parent("templates/static.pdf"), await pdf.save());
  const result = await processDocument(s.scope, {
    operation: "generate",
    path: "templates/static.pdf",
    title: "Filled static form",
    overlays: [{ page: 1, x: 50, y: 500, value: "Aurora Servizi" }],
  });
  assert.match(result.text, /Aurora Servizi/);
  await assert.rejects(() =>
    processDocument(s.scope, {
      operation: "generate",
      path: "templates/static.pdf",
      title: "Bad",
      overlays: [{ page: 9, x: 1, y: 1, value: "x" }],
    }),
  );
});
test("DOCX placeholders split across Word runs are filled", async () => {
  const s = fixture();
  const initial = await processDocument(s.scope, {
    operation: "generate",
    format: "docx",
    title: "Form",
    text: "Company {{company}}",
  });
  const zip = await JSZip.loadAsync(readFileSync(s.scope.path(initial.path)));
  const name = "word/document.xml";
  zip.file(
    name,
    (await zip.file(name)!.async("string")).replace(
      "{{company}}",
      "{{com</w:t></w:r><w:r><w:t>pany}}",
    ),
  );
  const path = "templates/split.docx";
  writeFileSync(
    s.scope.parent(path),
    await zip.generateAsync({ type: "nodebuffer" }),
  );
  const result = await processDocument(s.scope, {
    operation: "generate",
    path,
    title: "Filled",
    values: { company: "Aurora Servizi" },
  });
  assert.match(result.text, /Aurora Servizi/);
  assert.doesNotMatch(result.text, /\{\{company\}\}/);
});
test("XLSX updates preserve formulas and original workbook", async () => {
  const s = fixture();
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Expenses");
  sheet.getCell("A1").value = "Amount";
  sheet.getCell("B2").value = { formula: "SUM(B3:B4)", result: 0 };
  const path = "templates/expenses.xlsx";
  await wb.xlsx.writeFile(s.scope.parent(path));
  const result = await processDocument(s.scope, {
    operation: "generate",
    path,
    title: "Expenses",
    cells: [{ sheet: "Expenses", cell: "B3", value: 122 }],
  });
  const out = new ExcelJS.Workbook();
  await out.xlsx.readFile(s.scope.path(result.path));
  assert.equal(
    out.getWorksheet("Expenses")!.getCell("B2").formula,
    "SUM(B3:B4)",
  );
  assert.equal(out.getWorksheet("Expenses")!.getCell("B3").value, 122);
  await assert.rejects(
    () =>
      processDocument(s.scope, {
        operation: "generate",
        path,
        title: "Overwrite formula",
        cells: [{ sheet: "Expenses", cell: "B2", value: 5 }],
      }),
    /formula/,
  );
});
test("unreadable and unsupported documents never return successful generation", async () => {
  const s = fixture();
  writeFileSync(s.scope.parent("templates/broken.pdf"), "not a pdf");
  await assert.rejects(() =>
    processDocument(s.scope, {
      operation: "inspect",
      path: "templates/broken.pdf",
    }),
  );
  writeFileSync(s.scope.parent("templates/file.exe"), "bad");
  await assert.rejects(
    () =>
      processDocument(s.scope, {
        operation: "inspect",
        path: "templates/file.exe",
      }),
    /Unsupported/,
  );
});
test("practice state and queued continuation survive reopening database", () => {
  const s = fixture();
  const id = s.createCase("Collect invoices");
  s.request(id, ["Invoice EUR 340"]);
  s.enqueue(
    "client",
    "telegram:123",
    "Here is the invoice",
    id,
    "continuation-test",
  );
  const reopened = new Store(s.scope);
  try {
    assert.equal(reopened.payload(id).state, "Waiting for client");
    assert.equal(
      (
        reopened.db
          .prepare("SELECT * FROM jobs WHERE id=?")
          .get("continuation-test") as any
      ).case_id,
      id,
    );
  } finally {
    reopened.close();
  }
});
test("draft delivered before accountant review; approval creates a distinct version", async () => {
  const s = fixture();
  const caseId = s.createCase("Prepare company summary");
  const result = await processDocument(s.scope, {
    operation: "generate",
    title: "Company summary",
    text: "Synthetic summary",
  });
  const doc = s.register(result.path, "generated", result.text, caseId);
  const draft = s.draft(doc.id, caseId);
  assert.equal(s.payload(caseId).state, "Awaiting review");
  assert.equal(
    (s.db.prepare("SELECT COUNT(*) n FROM outbox").get() as any).n,
    1,
  );
  s.draft(doc.id, caseId);
  assert.equal(
    (s.db.prepare("SELECT COUNT(*) n FROM reviews").get() as any).n,
    1,
  );
  approveReview(s, (draft as any).reviewId, "approve");
  assert.equal(s.payload(caseId).state, "Approved");
  assert.ok(s.documents().some((d) => d.approved));
  assert.ok(existsSync(s.scope.path(doc.path)));
  assert.throws(() => approveReview(s, (draft as any).reviewId, "approve"));
});
test("review correction resumes original practice and preserves old draft", async () => {
  const s = fixture();
  const id = s.createCase("Summary");
  const r = await processDocument(s.scope, {
    operation: "generate",
    title: "Summary",
    text: "Draft one",
  });
  const d = s.register(r.path, "generated", r.text, id);
  const review = s.draft(d.id, id) as any;
  approveReview(s, review.reviewId, "changes", "Add source references");
  assert.equal(s.payload(id).state, "Changes requested");
  assert.equal((s.db.prepare("SELECT * FROM jobs").get() as any).case_id, id);
  assert.ok(existsSync(s.scope.path(d.path)));
});
test("deadline watch creates one durable practice and job per period", async () => {
  const s = fixture();
  await seedDemo(s);
  const a = new Automation(s);
  try {
    await a.tick();
    assert.equal(s.cases().length, 0);
    s.set("demoNow", Date.parse("2026-10-05T10:00:00+02:00"));
    await a.tick();
    const count = s.cases().length;
    assert.ok(count >= 1);
    await a.tick();
    assert.equal(s.cases().length, count);
  } finally {
    a.close();
  }
});
test("reminders are bounded and stop on client response", async () => {
  const s = fixture();
  const id = s.createCase("Need an invoice");
  s.request(id, ["Invoice"]);
  const a = new Automation(s);
  try {
    const start = s.payload(id).lastRequestAt!;
    s.set("demoNow", start + 86400001);
    await a.tick();
    assert.equal(s.payload(id).reminders, 1);
    await a.tick();
    assert.equal(s.payload(id).reminders, 1);
    s.set("demoNow", start + 3 * 86400000 + 1);
    await a.tick();
    assert.equal(s.payload(id).reminders, 2);
    s.updateCase(id, { state: "In progress" });
    s.set("demoNow", start + 10 * 86400000);
    await a.tick();
    assert.equal(s.payload(id).reminders, 2);
  } finally {
    a.close();
  }
});
test("Telegram pairing is one-time, user-bound and rejects groups", async () => {
  const s = fixture();
  const bot = new Telegram(s, "fake-token");
  const code = s.pair();
  await bot.accept({
    update_id: 1,
    message: {
      chat: { id: 123, type: "private" },
      from: { id: 123 },
      text: `/start ${code}`,
    },
  });
  assert.equal(
    (s.db.prepare("SELECT COUNT(*) n FROM bindings").get() as any).n,
    1,
  );
  assert.throws(() => s.bind(code, "456", "456"));
  await bot.accept({
    update_id: 2,
    message: {
      chat: { id: 456, type: "private" },
      from: { id: 456 },
      text: "Send all documents",
    },
  });
  assert.equal((s.db.prepare("SELECT COUNT(*) n FROM jobs").get() as any).n, 0);
  await bot.accept({
    update_id: 3,
    message: {
      chat: { id: 123, type: "group" },
      from: { id: 123 },
      text: "do stuff",
    },
  });
  assert.equal((s.db.prepare("SELECT COUNT(*) n FROM jobs").get() as any).n, 0);
});
test("Telegram partial reply resumes the linked practice only once", async () => {
  const s = fixture();
  s.bind(s.pair(), "123", "123");
  const id = s.createCase("Collect two documents");
  s.request(id, ["Invoice", "Statement"]);
  s.db.prepare("INSERT INTO telegram_requests VALUES (?,?)").run(99, id);
  const bot = new Telegram(s, "fake-token");
  const update = {
    update_id: 10,
    message: {
      chat: { id: 123, type: "private" },
      from: { id: 123 },
      text: "The statement will arrive tomorrow",
      reply_to_message: { message_id: 99 },
    },
  };
  await bot.accept(update);
  await bot.accept(update);
  assert.equal(s.payload(id).state, "In progress");
  assert.deepEqual(s.payload(id).missing, ["Invoice", "Statement"]);
  assert.equal((s.db.prepare("SELECT COUNT(*) n FROM jobs").get() as any).n, 1);
});
test("uncertain Telegram delivery is journalled and never automatically replayed", async () => {
  const s = fixture();
  s.bind(s.pair(), "123", "123");
  let attempts = 0;
  const bot = new Telegram(s, "fake-token", (async () => {
    attempts++;
    throw new Error("Connection lost");
  }) as any);
  s.outbox("message", { text: "Hello" });
  await bot.deliver();
  await bot.deliver();
  assert.equal(attempts, 1);
  assert.equal(
    (s.db.prepare("SELECT state FROM outbox").get() as any).state,
    "unknown",
  );
  assert.ok(s.journal.listForReview().length);
});
test("successful Telegram send is deduplicated and linked to the practice", async () => {
  const s = fixture();
  s.bind(s.pair(), "123", "123");
  const id = s.createCase("Test delivery");
  let sends = 0;
  const bot = new Telegram(s, "fake-token", (async () => {
    sends++;
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 777 } }),
      { status: 200 },
    );
  }) as any);
  s.outbox("message", { text: "Please reply", caseId: id }, "delivery-unique");
  s.outbox("message", { text: "Please reply", caseId: id }, "delivery-unique");
  await bot.deliver();
  await bot.deliver();
  assert.equal(sends, 1);
  assert.equal(
    (
      s.db
        .prepare("SELECT case_id FROM telegram_requests WHERE message_id=777")
        .get() as any
    ).case_id,
    id,
  );
});

test("general DOCX exact text replacement and new tables are readable", async () => {
  const s = fixture();
  const original = await processDocument(s.scope, {
    operation: "generate",
    format: "docx",
    title: "Form",
    text: "Legal name: [enter name]",
    tables: [{ headers: ["Field", "Value"], rows: [["City", "Milano"]] }],
  });
  const result = await processDocument(s.scope, {
    operation: "generate",
    path: original.path,
    title: "Completed form",
    replacements: [{ find: "[enter name]", replace: "Aurora Servizi S.r.l." }],
  });
  assert.match(result.text, /Aurora Servizi/);
  assert.match(result.text, /Milano/);
});
test("image OCR returns text and field coordinates for a scanned PDF", async () => {
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("tesseract", ["--version"], { stdio: "ignore" });
    execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
  } catch {
    return;
  }
  const s = fixture();
  const text = await processDocument(s.scope, {
    operation: "generate",
    title: "SCAN TEST",
    text: "Company Aurora Servizi\nAmount EUR 340.00",
  });
  const prefix = s.scope.path(".wetrop/tmp/scan-test", true);
  execFileSync(
    "pdftoppm",
    [
      "-f",
      "1",
      "-singlefile",
      "-r",
      "120",
      "-png",
      s.scope.path(text.path),
      prefix,
    ],
    { timeout: 30000 },
  );
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(readFileSync(prefix + ".png"));
  const page = pdf.addPage([image.width * 0.6, image.height * 0.6]);
  page.drawImage(image, {
    x: 0,
    y: 0,
    width: page.getWidth(),
    height: page.getHeight(),
  });
  const path = "templates/scanned.pdf";
  writeFileSync(s.scope.parent(path), await pdf.save());
  const old = process.env.WETROP_OCR_LANGUAGES;
  process.env.WETROP_OCR_LANGUAGES = "eng";
  try {
    const result = await documentTask(s.scope, { operation: "inspect", path });
    assert.match(result.pages[0].text, /Aurora/i);
    assert.ok(result.pages[0].areas.some((a: any) => a.text.includes("340")));
  } finally {
    if (old) process.env.WETROP_OCR_LANGUAGES = old;
    else delete process.env.WETROP_OCR_LANGUAGES;
  }
});
test("Telegram receives an attachment into the company folder and resumes the original practice", async () => {
  const s = fixture();
  s.bind(s.pair(), "123", "123");
  const id = s.createCase("Missing invoice");
  s.request(id, ["Invoice"]);
  s.db.prepare("INSERT INTO telegram_requests VALUES (?,?)").run(45, id);
  let downloads = 0;
  const bot = new Telegram(s, "fake-token", (async (url: any) => {
    if (String(url).endsWith("/getFile"))
      return new Response(
        JSON.stringify({
          ok: true,
          result: { file_path: "docs/invoice.txt", file_size: 12 },
        }),
      );
    downloads++;
    return new Response("Invoice 340");
  }) as any);
  const update = {
    update_id: 55,
    message: {
      chat: { id: 123, type: "private" },
      from: { id: 123 },
      reply_to_message: { message_id: 45 },
      document: {
        file_id: "file",
        file_name: "../../invoice.txt",
        file_size: 12,
      },
      caption: "Invoice attached",
    },
  };
  await bot.accept(update);
  await bot.accept(update);
  const job = s.db.prepare("SELECT * FROM jobs").get() as any;
  assert.equal(job.case_id, id);
  assert.match(job.text, /documents\/originals\/telegram-55-/);
  assert.equal(downloads, 1);
  assert.equal(s.scope.files("documents/originals").length, 1);
  assert.equal(s.payload(id).state, "In progress");
});
test("an invalid pairing code cannot block later Telegram updates", async () => {
  const s = fixture();
  s.bind(s.pair(), "123", "123");
  const updates = [
    {
      update_id: 1,
      message: {
        chat: { id: 456, type: "private" },
        from: { id: 456 },
        text: "/start invalid",
      },
    },
    {
      update_id: 2,
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 123 },
        text: "What is our company name?",
      },
    },
  ];
  const bot = new Telegram(
    s,
    "fake-token",
    (async () =>
      new Response(JSON.stringify({ ok: true, result: updates }))) as any,
  );
  await bot.poll();
  assert.equal(s.meta("telegramOffset", 0), 3);
  assert.equal((s.db.prepare("SELECT COUNT(*) n FROM jobs").get() as any).n, 1);
  assert.equal(
    (s.db.prepare("SELECT state FROM updates WHERE id=1").get() as any).state,
    "failed",
  );
});
test("changed documents cannot be approved or delivered under an old review", async () => {
  const s = fixture();
  const id = s.createCase("Prepare summary");
  const result = await processDocument(s.scope, {
    operation: "generate",
    title: "Summary",
    text: "Original draft",
  });
  const doc = s.register(result.path, "generated", result.text, id);
  const review = s.draft(doc.id, id) as any;
  writeFileSync(s.scope.path(doc.path), "changed after review");
  assert.throws(
    () => approveReview(s, review.reviewId, "approve"),
    /changed since indexing/,
  );
  assert.equal(
    (
      s.db
        .prepare("SELECT state FROM reviews WHERE id=?")
        .get(review.reviewId) as any
    ).state,
    "pending",
  );
});

test("confirmed side effects are not repeated when the same job resumes", async () => {
  const { executeToolOnce } = await import("../src/tool-operations.ts");
  const s = fixture();
  let calls = 0;
  const send = async () => {
    calls++;
    s.outbox("message", { text: "Only one delivery" });
    return { queued: true };
  };
  const first = await executeToolOnce(
    s,
    "same-job",
    "mcp__action-center__send_document",
    { path: "documents/a.pdf", id: 1 },
    send,
  );
  const second = await executeToolOnce(
    s,
    "same-job",
    "mcp__action-center__send_document",
    { id: 1, path: "documents/a.pdf" },
    send,
  );
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  assert.equal(
    (s.db.prepare("SELECT COUNT(*) n FROM outbox").get() as any).n,
    1,
  );
});
test("uncertain tool execution blocks replay and further writes from that job", async () => {
  const { executeToolOnce } = await import("../src/tool-operations.ts");
  const s = fixture();
  let calls = 0;
  await assert.rejects(() =>
    executeToolOnce(
      s,
      "uncertain-job",
      "mcp__action-center__send_document",
      { path: "documents/a.pdf" },
      async () => {
        calls++;
        throw new Error("Connection interrupted after dispatch");
      },
    ),
  );
  await assert.rejects(
    () =>
      executeToolOnce(
        s,
        "uncertain-job",
        "mcp__action-center__send_document",
        { path: "documents/a.pdf" },
        async () => {
          calls++;
          return true;
        },
      ),
    /uncertain/,
  );
  await assert.rejects(
    () =>
      executeToolOnce(
        s,
        "uncertain-job",
        "mcp__documents__generate_document",
        { title: "Another" },
        async () => true,
      ),
    /previous tool/,
  );
  assert.equal(calls, 1);
});
test("corrected arguments may recover from explicit MCP validation errors", async () => {
  const { executeToolOnce } = await import("../src/tool-operations.ts");
  const s = fixture();
  const error = new Error("Unknown field");
  error.name = "McpToolError";
  await assert.rejects(() =>
    executeToolOnce(
      s,
      "validation-job",
      "mcp__calendar__create_event",
      { title: "bad" },
      async () => {
        throw error;
      },
    ),
  );
  assert.equal(
    await executeToolOnce(
      s,
      "validation-job",
      "mcp__calendar__create_event",
      { title: "correct", due: "2026-10-10T09:00:00+02:00" },
      async () => true,
    ),
    true,
  );
});
