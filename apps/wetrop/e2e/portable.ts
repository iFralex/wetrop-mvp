import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import ExcelJS from "exceljs";
import { CompanyScope, initializeScope } from "../src/scope.ts";
import { processDocument } from "../src/documents.ts";
import { projectRoot } from "../src/setup.ts";
const root = resolve(projectRoot, ".runtime/portable-test-" + process.pid);
const scope = new CompanyScope(root);
initializeScope(scope);
const canvas = createCanvas(1200, 400),
  ctx = canvas.getContext("2d");
ctx.fillStyle = "white";
ctx.fillRect(0, 0, 1200, 400);
ctx.fillStyle = "black";
ctx.font = "40px sans-serif";
ctx.fillText("AURORA SERVIZI - DEMO INVOICE", 40, 90);
ctx.fillText("TOTAL EUR 85.40", 40, 200);
ctx.fillText("SYNTHETIC DOCUMENT", 40, 300);
const png = canvas.toBuffer("image/png");
writeFileSync(scope.parent("documents/originals/scan.png"), png);
const pdf = await PDFDocument.create();
const image = await pdf.embedPng(png);
pdf
  .addPage([720, 240])
  .drawImage(image, { x: 0, y: 0, width: 720, height: 240 });
writeFileSync(scope.parent("documents/originals/scan.pdf"), await pdf.save());
await processDocument(scope, {
  operation: "generate",
  format: "docx",
  title: "Preview test",
  text: "Aurora document — total €85.40",
});
const form = await PDFDocument.create();
form
  .getForm()
  .createTextField("company")
  .addToPage(form.addPage(), { x: 50, y: 600, width: 300, height: 30 });
writeFileSync(scope.parent("templates/form.pdf"), await form.save());
const wb = new ExcelJS.Workbook();
const sheet = wb.addWorksheet("Expenses");
sheet.getCell("B4").value = 0;
sheet.getCell("B5").value = 0;
sheet.getCell("B6").value = { formula: "SUM(B4:B5)", result: 0 };
await wb.xlsx.writeFile(scope.parent("templates/expenses.xlsx"));
const code = `import assert from 'node:assert/strict';import fs from'node:fs';import{CompanyScope}from'/app/apps/wetrop/src/scope.ts';import{documentTask}from'/app/apps/wetrop/src/documents.ts';const s=new CompanyScope('/company');for(const name of['scan.png','scan.pdf']){const r=await documentTask(s,{operation:'inspect',path:'documents/originals/'+name});assert.match(r.pages.map(p=>p.text).join(' '),/85[.,]40/);assert.ok(r.pages[0].areas.length);console.log(name+': offline OCR text, areas and amount correct');}const name=fs.readdirSync('/company/documents/generated').find(n=>n.endsWith('.docx'));const converted=await documentTask(s,{operation:'convert',path:'documents/generated/'+name});assert.equal(converted.provenance.conversion,'normalized-content-preview');assert.match(converted.warnings.join(' '),/layout/);const preview=await documentTask(s,{operation:'inspect',path:converted.path});assert.match(preview.pages.map(p=>p.text).join(' '),/85.40/);console.log('Office normalized PDF preview verified with explicit layout warning');
const form=await documentTask(s,{operation:'generate',path:'templates/form.pdf',title:'Filled company form',values:{company:'Aurora Servizi'}});assert.match(form.text,/Aurora Servizi/);console.log('PDF form filled and verified');
const overlay=await documentTask(s,{operation:'generate',path:'documents/originals/scan.pdf',title:'Verified scanned form',overlays:[{page:1,x:25,y:5,value:'Verified: Aurora Servizi'}]});assert.match(overlay.text,/Verified: Aurora Servizi/);console.log('Scanned PDF overlay filled and verified');
const workbook=await documentTask(s,{operation:'generate',path:'templates/expenses.xlsx',title:'Expenses',cells:[{sheet:'Expenses',cell:'B4',value:122},{sheet:'Expenses',cell:'B5',value:340}]});const{createRequire}=await import('node:module');const require=createRequire('/app/package.json');const ExcelJS=require('exceljs');const filled=new ExcelJS.Workbook();await filled.xlsx.readFile(s.path(workbook.path));assert.equal(filled.getWorksheet('Expenses').getCell('B6').formula,'SUM(B4:B5)');assert.equal(filled.getWorksheet('Expenses').getCell('B4').value+filled.getWorksheet('Expenses').getCell('B5').value,462);console.log('XLSX filled: EUR 462.00, original formula preserved');`;
writeFileSync(scope.parent(".wetrop/tmp/verify.mts", true), code);
try {
  const args = [
    "run",
    "--rm",
    "--read-only",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--memory",
    "2g",
    "--user",
    process.getuid!() + ":" + process.getgid!(),
    "-e",
    "COMPANY_ROOT=/company",
    "-e",
    "WETROP_OCR_ASSETS=/app/ocr-assets",
    "--mount",
    `type=bind,source=${root},target=/company`,
    ...["node_modules", "apps", "packages", "package.json"].flatMap((p) => [
      "--mount",
      `type=bind,source=${resolve(projectRoot, p)},target=/app/${p},readonly`,
    ]),
    "--mount",
    `type=bind,source=${resolve(projectRoot, ".runtime/ocr-assets")},target=/app/ocr-assets,readonly`,
    "-w",
    "/app",
    "public.ecr.aws/docker/library/node:24-bookworm-slim",
    "node",
    "--experimental-transform-types",
    "/company/.wetrop/tmp/verify.mts",
  ];
  console.log(
    execFileSync("docker", args, { encoding: "utf8", timeout: 180000 }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
