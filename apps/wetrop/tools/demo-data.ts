import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { CompanyScope } from "../src/scope.ts";
import { projectRoot } from "../src/setup.ts";
import { Store } from "../src/store.ts";
import { seedDemo } from "../src/seed.ts";
import { processDocument } from "../src/documents.ts";
import { updateWiki, graph } from "../src/wiki.ts";
import { Automation } from "../src/automation.ts";
import { approveReview } from "../src/server.ts";
import { auditLog } from "@steward/audit-log";
import { usageLedger } from "@steward/usage-ledger";
import Database from "@steward/sqlite";
const rootScope = new CompanyScope(projectRoot);
const bundled = rootScope.path("demo/aurora", true);
function inventory(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(dir: string) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name),
        st = lstatSync(path);
      if (st.isSymbolicLink()) throw new Error("Demo links are forbidden");
      if (st.isDirectory()) walk(path);
      else
        result[relative(root, path).replaceAll("\\", "/")] = createHash(
          "sha256",
        )
          .update(readFileSync(path))
          .digest("hex");
    }
  }
  walk(root);
  return result;
}
const command = process.argv[2];
if (command === "restore") {
  const manifest = JSON.parse(
    readFileSync(rootScope.path("demo/manifest.json", true), "utf8"),
  );
  if (
    manifest.synthetic !== true ||
    JSON.stringify(inventory(bundled)) !== JSON.stringify(manifest.files)
  )
    throw new Error("Bundled demo checksum verification failed");
  const target = rootScope.path("company", true);
  if (existsSync(target) && readdirSync(target).length)
    throw new Error(
      "Company is not empty. Stop Wetrop and archive its company folder before restoring. No data was overwritten.",
    );
  cpSync(bundled, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  console.log(
    "Synthetic company restored, including databases. Pair your own Telegram account and sign in separately.",
  );
} else if (command === "snapshot") {
  const staging = rootScope.mkdir(".runtime/demo-build-" + Date.now(), true);
  process.env.COMPANY_ROOT = staging;
  const scope = new CompanyScope(staging),
    store = new Store(scope);
  await seedDemo(store);
  const automation = new Automation(store);
  const waiting = store.createCase(
    "Synthetic example: collect the missing September supplier invoice",
    "demo",
    "demo-missing-invoice",
    "2026-09",
  );
  store.request(waiting, ["Forniture Demo invoice for EUR 340.00"]);
  const createSummary = async (title: string) => {
    const id = store.createCase(title, "demo", title, "2026-09");
    const generated = await processDocument(scope, {
      operation: "generate",
      format: "pdf",
      title,
      text: "SYNTHETIC DEMO DOCUMENT — NOT VALID FOR TAX PURPOSES\nSeptember 2026 expenses: EUR 462.00 (Energia EUR 122.00 + Forniture payment EUR 340.00).\nThe Forniture invoice is intentionally missing. Source: documents/originals/bank-september.csv. This is a cash-movement summary, not a VAT calculation or profit statement.",
    });
    const doc = store.register(
      generated.path,
      "generated",
      generated.text,
      id,
      { sources: ["documents/originals/bank-september.csv"], synthetic: true },
    );
    updateWiki(store, doc);
    const draft = store.draft(doc.id, id) as { reviewId: string };
    return { id, reviewId: draft.reviewId };
  };
  await createSummary("Synthetic September expense draft awaiting review");
  const approved = await createSummary(
    "Synthetic approved September expense example",
  );
  approveReview(
    store,
    approved.reviewId,
    "approve",
    "Seeded synthetic review — no real communication took place.",
  );
  const form = await PDFDocument.create();
  form
    .getForm()
    .createTextField("company")
    .addToPage(form.addPage(), { x: 50, y: 600, width: 350, height: 30 });
  writeFileSync(
    scope.parent("templates/fillable-company.pdf"),
    await form.save(),
  );
  const canvas = createCanvas(1200, 400),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1200, 400);
  ctx.fillStyle = "black";
  ctx.font = "40px sans-serif";
  ctx.fillText("SYNTHETIC INVOICE OCR-DEMO", 40, 90);
  ctx.fillText("Aurora Servizi - Total EUR 85.40", 40, 200);
  ctx.fillText("NOT VALID FOR TAX PURPOSES", 40, 300);
  const png = canvas.toBuffer("image/png");
  writeFileSync(scope.parent("templates/scanned-invoice.png"), png);
  const scan = await PDFDocument.create(),
    image = await scan.embedPng(png);
  scan
    .addPage([720, 240])
    .drawImage(image, { x: 0, y: 0, width: 720, height: 240 });
  writeFileSync(
    scope.parent("templates/scanned-invoice.pdf"),
    await scan.save(),
  );
  store.message(
    "studio",
    "assistant",
    "This workspace contains synthetic demonstration practices. No real customer messages were sent.",
  );
  store.set("bundledSyntheticDemo", true);
  // Never export transport bindings, pending sends, account sessions or executable jobs.
  for (const table of [
    "bindings",
    "pairing",
    "telegram_requests",
    "updates",
    "outbox",
    "jobs",
    "tool_operations",
    "job_leases",
  ])
    store.db.exec("DELETE FROM " + table);
  store.audit(
    "demo.snapshot",
    "Bundled synthetic demonstration dataset generated locally; no real account or client attached.",
  );
  graph(store);
  const counts = {
    documents: store.documents().length,
    practices: store.cases().length,
    deadlines: (
      store.db.prepare("SELECT COUNT(*) n FROM calendar").get() as any
    ).n,
  };
  automation.close();
  store.close();
  auditLog().raw.close();
  usageLedger().raw.close();
  // Reopen every database to verify integrity and create self-contained, compact files.
  for (const path of Object.keys(inventory(staging)).filter((p) =>
    p.endsWith(".db"),
  )) {
    const db = new Database(join(staging, path));
    if (
      (db.prepare("PRAGMA integrity_check").get() as any).integrity_check !==
      "ok"
    )
      throw new Error("Invalid demo database: " + path);
    db.exec("VACUUM");
    db.close();
  }
  if (existsSync(bundled)) {
    if (
      readFileSync(join(bundled, ".wetrop/demo-marker"), "utf8").trim() !==
      "wetrop-demo:aurora"
    )
      throw new Error("Refusing to replace an unmarked demo folder");
    renameSync(
      bundled,
      rootScope.path(".runtime/demo-bundle-archive-" + Date.now(), true),
    );
  }
  mkdirSync(resolve(bundled, ".."), { recursive: true });
  cpSync(staging, bundled, { recursive: true });
  const manifest = {
    format: 1,
    synthetic: true,
    company: "Aurora Servizi S.r.l.",
    ...counts,
    files: inventory(bundled),
  };
  writeFileSync(
    rootScope.parent("demo/manifest.json", true),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  rmSync(staging, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        snapshot: "demo/aurora",
        ...counts,
        files: Object.keys(manifest.files).length,
        credentials: false,
        queuedSends: 0,
      },
      null,
      2,
    ),
  );
} else throw new Error("Use snapshot or restore");
