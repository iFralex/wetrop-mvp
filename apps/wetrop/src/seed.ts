import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { CompanyScope } from "./scope.ts";
import { Store } from "./store.ts";
import { processDocument } from "./documents.ts";
import { updateWiki, graph } from "./wiki.ts";
export async function seedDemo(s: Store) {
  if (s.meta("seeded", false)) {
    writeFileSync(
      s.scope.parent(".wetrop/demo-marker", true),
      "wetrop-demo:aurora\n",
    );
    return;
  }
  const profile = {
    name: "Aurora Servizi S.r.l.",
    vatNumber: "DEMO-IT-00000000000",
    taxRegime: "Ordinary, monthly VAT — synthetic demo",
    address: "Via Esempio 12, Milano",
    email: "amministrazione@example.invalid",
    iban: "DEMO-NOT-A-BANK-ACCOUNT",
  };
  s.set("company", profile);
  const save = (path: string, text: string) => {
    if (!existsSync(s.scope.path(path)))
      writeFileSync(s.scope.parent(path), text, { flag: "wx", mode: 0o600 });
  };
  save(
    "wiki/wiki/company.md",
    `---\ntitle: Aurora Servizi S.r.l.\ntype: entity\nsources:\n  - documents/originals/company-profile.json\n---\n# Aurora Servizi S.r.l.\n\nSynthetic company for demonstration. All identifiers are deliberately invalid.\n\n${JSON.stringify(profile, null, 2)}\n\n[[supplier-energia]] [[period-2026-09]] [[studio-instructions]]\n`,
  );
  save(
    "documents/originals/company-profile.json",
    JSON.stringify(profile, null, 2),
  );
  save(
    "wiki/wiki/supplier-energia.md",
    "# Energia Demo S.r.l.\n\n[[company]] [[period-2026-09]]\n\nSynthetic electricity supplier. September invoice: EUR 122.00 including VAT.\nSource: documents/originals/energia-september.txt\n",
  );
  save(
    "wiki/wiki/period-2026-09.md",
    "# September 2026\n\n[[company]] [[supplier-energia]]\n\nSource bank movements include a EUR 340 payment to Forniture Demo. The corresponding invoice is intentionally absent and must be requested.\nSource: documents/originals/bank-september.csv\n",
  );
  save(
    "wiki/wiki/studio-instructions.md",
    "# Studio instructions\n\n[[company]]\n\nAmounts are synthetic. Every new document is a draft pending accountant review. Internal preparation dates are not statutory tax deadlines. Never invent client statements or missing invoices.\n",
  );
  save(
    "documents/originals/energia-september.txt",
    "SYNTHETIC INVOICE — NOT VALID FOR TAX PURPOSES\nSupplier: Energia Demo S.r.l.\nCustomer: Aurora Servizi S.r.l.\nInvoice: EN-2026-09\nDate: 2026-09-30\nNet EUR 100.00\nVAT EUR 22.00\nTotal EUR 122.00\n",
  );
  save(
    "documents/originals/bank-september.csv",
    "date,counterparty,amount,reference\n2026-09-30,Energia Demo Srl,-122.00,EN-2026-09\n2026-09-12,Forniture Demo Srl,-340.00,Invoice missing\n2026-09-20,Cliente Demo,1220.00,INV-2026-15\n",
  );
  save(
    "documents/originals/sales-september.csv",
    "invoice,date,net,vat,total,customer\nINV-2026-15,2026-09-20,1000.00,220.00,1220.00,Cliente Demo\n",
  );
  for (const path of s.scope.files("documents/originals")) {
    const text = readFileSync(s.scope.path(path), "utf8");
    const doc = s.register(path, "seed", text);
    updateWiki(s, doc);
  }
  const fixtures = [
    {
      format: "docx" as const,
      title: "Administrative company form",
      text: "Company: {{company}}\nVAT identifier: {{vat}}\nPeriod: {{period}}\nClient declaration: {{declaration}}",
    },
    {
      format: "xlsx" as const,
      title: "Monthly expense summary",
      values: { Company: profile.name, Period: "September 2026" },
    },
    {
      format: "pdf" as const,
      title: "Company profile",
      text: JSON.stringify(profile, null, 2),
    },
  ];
  for (const task of fixtures) {
    const result = await processDocument(s.scope, {
      ...task,
      operation: "generate",
    });
    const ext = task.format;
    const path = `templates/company-form.${ext}`;
    writeFileSync(
      s.scope.parent(path),
      readFileSync(s.scope.path(result.path)),
      { flag: "wx" },
    );
  }
  const deadlines = [
    [
      "monthly-collection",
      "Monthly document collection",
      "2026-10-05T09:00:00+02:00",
      "2026-09",
      "Collect September invoices, compare with bank-september.csv, request the missing Forniture Demo invoice for EUR 340, then prepare a ZIP with CSV index.",
    ],
    [
      "monthly-vat",
      "Monthly VAT preparation",
      "2026-10-10T09:00:00+02:00",
      "2026-09",
      "Gather September sales and purchase invoices and available registers. Prepare a source-backed VAT preparation dossier with unknowns explicit. Do not infer a final tax payment.",
    ],
    [
      "withholding",
      "Withholding and F24 preparation",
      "2026-10-12T09:00:00+02:00",
      "2026-09",
      "Request professional invoices and related payment evidence for September. Prepare a withholding checklist for the accountant; do not calculate unsupported taxes or submit F24.",
    ],
    [
      "lipe",
      "Quarterly LIPE preparation",
      "2026-11-10T09:00:00+01:00",
      "2026-Q3",
      "Gather July, August and September VAT summaries and any receipts. Request missing months and produce a quarterly completeness dossier.",
    ],
    [
      "certifications",
      "Annual compensation certifications preparation",
      "2027-02-05T09:00:00+01:00",
      "2026",
      "Collect professional compensation, withholding evidence and recipient data for 2026; ask the client for missing recipient tax details; prepare a review spreadsheet.",
    ],
    [
      "year-close",
      "Annual closing dossier",
      "2027-01-20T09:00:00+01:00",
      "2026",
      "Collect year-end bank statements, balances and adjustment documents requested by the accountant. Prepare a closing dossier and unresolved-items list.",
    ],
  ];
  for (const [id, title, due, period, task] of deadlines)
    s.db
      .prepare("INSERT OR IGNORE INTO calendar VALUES (?,?,?,?,?,1,7)")
      .run(id, title, due, task, period);
  // Freeze the demo before its first trigger; advancing the clock is an explicit studio action.
  s.set("demoNow", Date.parse("2026-09-20T09:00:00+02:00"));
  s.set("seeded", true);
  writeFileSync(
    s.scope.parent(".wetrop/demo-marker", true),
    "wetrop-demo:aurora\n",
  );
  graph(s);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { localScope } = await import("./setup.ts");
  const s = new Store(localScope());
  try {
    await seedDemo(s);
    console.log(`Wetrop demo seeded inside ${s.scope.root}`);
  } finally {
    s.close();
  }
}
