import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { CompanyScope } from "./scope.ts";
import { validateArchiveBudget } from "../../documents-mcp/src/archive-budget.ts";
import { readPdfDocument } from "../../documents-mcp/src/readers/pdf.ts";
import { readDocx } from "../../documents-mcp/src/readers/office.ts";
const execute = promisify(execFile);
const xml = (s: unknown) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
const plain = (value: unknown) =>
  String(value)
    .replace(/[–—−]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/€/g, "EUR")
    .replace(/[•]/g, "-")
    .replace(/[^\x20-\x7e\n\r\t\u00a0-\u00ff]/g, "?");

export interface DocumentTask {
  operation: "inspect" | "generate" | "convert";
  path?: string;
  format?: "pdf" | "docx" | "xlsx";
  title?: string;
  text?: string;
  values?: Record<string, string>;
  cells?: Array<{ sheet: string; cell: string; value: string | number }>;
  tables?: Array<{ headers: string[]; rows: string[][] }>;
  replacements?: Array<{ find: string; replace: string }>;
  overlays?: Array<{ page: number; x: number; y: number; value: string }>;
}

/** Existing extraction worker pattern: bounded heap, deadline, company-local temporary files. */
export async function documentTask(
  scope: CompanyScope,
  task: DocumentTask,
): Promise<any> {
  if (task.path) scope.path(task.path);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { root: scope.root, task },
      resourceLimits: { maxOldGenerationSizeMb: 384 },
    });
    let finished = false;
    const finish = (error?: Error, result?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Document processing timed out; no successful result published",
          ),
        ),
      120000,
    );
    worker.once("message", (m) =>
      finish(m.error ? new Error(m.error) : undefined, m.result),
    );
    worker.once("error", (e) => finish(e));
    worker.once("exit", (c) => {
      if (!finished) finish(new Error(`Document worker exited (${c})`));
    });
  });
}
async function portableOcr(scope: CompanyScope, path: string) {
  const { createWorker } = await import("tesseract.js");
  const assets =
    process.env.WETROP_OCR_ASSETS ??
    fileURLToPath(new URL("../../../.runtime/ocr-assets", import.meta.url));
  const languages = (process.env.WETROP_OCR_LANGUAGES ?? "ita+eng").split("+");
  for (const language of languages)
    if (!/^[a-z]{3}$/.test(language))
      throw new Error("Unsupported OCR language code");
  const worker = await createWorker(languages, 1, {
    langPath: assets,
    gzip: false,
    cacheMethod: "none",
    cachePath: scope.path(".wetrop/cache", true),
    workerBlobURL: false,
  });
  let pdf: any, loadingTask: any;
  const pages: any[] = [];
  try {
    const images: Array<{ bytes: Uint8Array; width: number; height: number }> =
      [];
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    if (extname(path).toLowerCase() === ".pdf") {
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const require = createRequire(import.meta.url);
      loadingTask = getDocument({
        data: new Uint8Array(readFileSync(scope.path(path))),
        useSystemFonts: false,
        standardFontDataUrl:
          dirname(require.resolve("pdfjs-dist/package.json")) +
          "/standard_fonts/",
      });
      pdf = await loadingTask.promise;
      for (let i = 1; i <= Math.min(pdf.numPages, 12); i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 120 / 72 });
        if (viewport.width * viewport.height > 20000000)
          throw new Error("OCR page exceeds the pixel limit");
        const canvas = createCanvas(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
        await page.render({
          canvas: canvas as any,
          canvasContext: canvas.getContext("2d") as any,
          viewport,
        }).promise;
        images.push({
          bytes: canvas.toBuffer("image/png"),
          width: page.view[2] - page.view[0],
          height: page.view[3] - page.view[1],
        });
        page.cleanup();
      }
    } else {
      const bytes = readFileSync(scope.path(path));
      const image = await loadImage(bytes);
      if (image.width * image.height > 20000000)
        throw new Error("OCR image exceeds the pixel limit");
      images.push({
        bytes,
        width: image.width * 0.6,
        height: image.height * 0.6,
      });
    }
    for (const image of images) {
      const { data } = await worker.recognize(
        image.bytes as any,
        {},
        { text: true, tsv: true },
      );
      const rows = String(data.tsv ?? "")
        .trim()
        .split("\n")
        .slice(1)
        .map((l) => l.split("\t"))
        .filter((r) => r[11]?.trim());
      pages.push({
        number: pages.length + 1,
        text: data.text.trim(),
        width: image.width,
        height: image.height,
        areas: rows.map((r) => ({
          x: +r[6],
          y: +r[7],
          width: +r[8],
          height: +r[9],
          confidence: +r[10],
          text: r[11],
        })),
      });
    }
    return {
      pages,
      warnings: [
        "Offline OCR output requires verification; PDF OCR is limited to the first 12 pages.",
      ],
      coordinateSystem:
        "OCR pixels at 120 dpi, origin top left; PDF page width/height and overlay positions are points, origin bottom left",
    };
  } finally {
    await worker.terminate();
    if (loadingTask) await loadingTask.destroy();
  }
}
async function ocr(scope: CompanyScope, path: string) {
  if (process.platform === "linux" || process.env.WETROP_OCR_ENGINE === "wasm")
    return portableOcr(scope, path);
  const temp = mkdtempSync(scope.path(".wetrop/tmp/ocr-", true));
  try {
    let images: string[];
    if (extname(path).toLowerCase() === ".pdf") {
      await execute(
        "pdftoppm",
        [
          "-r",
          "120",
          "-f",
          "1",
          "-l",
          "12",
          "-png",
          scope.path(path),
          join(temp, "page"),
        ],
        { timeout: 45000, maxBuffer: 1024 * 1024 },
      );
      images = readdirSync(temp)
        .filter((f) => f.endsWith(".png"))
        .sort()
        .map((f) => join(temp, f));
    } else images = [scope.path(path)];
    const pages = [];
    for (const image of images) {
      const { stdout } = await execute(
        "tesseract",
        [
          image,
          "stdout",
          "-l",
          process.env.WETROP_OCR_LANGUAGES ?? "ita+eng",
          "tsv",
        ],
        { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      );
      const rows = stdout
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => line.split("\t"))
        .filter((r) => r[11]?.trim());
      pages.push({
        number: pages.length + 1,
        text: rows.map((r) => r[11]).join(" "),
        areas: rows.map((r) => ({
          x: +r[6],
          y: +r[7],
          width: +r[8],
          height: +r[9],
          confidence: +r[10],
          text: r[11],
        })),
      });
    }
    return {
      pages,
      warnings: [
        "OCR output requires verification; PDF OCR is limited to the first 12 pages.",
      ],
      coordinateSystem:
        "OCR pixels at 120 dpi, origin top left; PDF overlays use points, origin bottom left",
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
async function inspect(scope: CompanyScope, path: string) {
  const full = scope.path(path);
  if (statSync(full).size > 25 * 1024 * 1024)
    throw new Error("Maximum document size is 25 MiB");
  const ext = extname(path).toLowerCase();
  if ([".docx", ".xlsx"].includes(ext))
    validateArchiveBudget(readFileSync(full));
  if (ext === ".docx") {
    const extracted = await readDocx(full);
    return {
      ...extracted,
      placeholders: [
        ...extracted.pages[0].text.matchAll(/\{\{([^}]+)\}\}/g),
      ].map((m) => m[1]),
    };
  }
  if (ext === ".xlsx") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(full);
    const sheets: any[] = [];
    wb.eachSheet((sheet) => {
      const cells: any[] = [];
      sheet.eachRow((row) =>
        row.eachCell((c) => {
          if (cells.length < 2000)
            cells.push({ cell: c.address, value: c.value });
        }),
      );
      sheets.push({ name: sheet.name, cells });
    });
    return {
      pages: [{ number: 1, text: JSON.stringify(sheets) }],
      sheets,
      warnings: [],
    };
  }
  if (ext === ".pdf") {
    const pdf = await PDFDocument.load(readFileSync(full));
    const fields = pdf
      .getForm()
      .getFields()
      .map((f) => ({ name: f.getName(), type: f.constructor.name }));
    const extracted = await readPdfDocument(full);
    if (extracted.pages.every((p) => !p.text.trim())) {
      const result = await ocr(scope, path);
      return {
        ...result,
        fields,
        pages: result.pages.map((p: any, i: number) => ({
          ...p,
          width: pdf.getPage(i).getWidth(),
          height: pdf.getPage(i).getHeight(),
        })),
      };
    }
    return {
      ...extracted,
      fields,
      pages: extracted.pages.map((p, i) => ({
        ...p,
        width: pdf.getPage(i).getWidth(),
        height: pdf.getPage(i).getHeight(),
      })),
    };
  }
  if ([".png", ".jpg", ".jpeg", ".tif", ".tiff"].includes(ext))
    return ocr(scope, path);
  if ([".txt", ".md", ".csv", ".json"].includes(ext))
    return {
      pages: [{ number: 1, text: readFileSync(full, "utf8").slice(0, 150000) }],
      warnings: [],
    };
  throw new Error(
    "Unsupported document format. Provide DOCX, XLSX, PDF, image, CSV or text.",
  );
}
async function makePdf(text: string) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let page = pdf.addPage();
  let y = page.getHeight() - 48;
  for (const line of plain(text)
    .split("\n")
    .flatMap((l) => {
      const result: string[] = [];
      let current = "";
      for (const word of l.split(/ +/)) {
        const next = current ? current + " " + word : word;
        if (
          font.widthOfTextAtSize(next, 11) > page.getWidth() - 84 &&
          current
        ) {
          result.push(current);
          current = word;
        } else current = next;
      }
      result.push(current);
      return result;
    })) {
    if (y < 45) {
      page = pdf.addPage();
      y = page.getHeight() - 48;
    }
    page.drawText(line, { x: 42, y, size: 11, font });
    y -= 16;
  }
  return pdf;
}
export async function processDocument(
  scope: CompanyScope,
  task: DocumentTask,
): Promise<any> {
  if (task.operation === "convert") {
    if (!task.path || ![".docx", ".xlsx"].includes(extname(task.path)))
      throw new Error("Only company DOCX/XLSX can be converted");
    const dir = mkdtempSync(scope.path(".wetrop/tmp/convert-", true));
    try {
      await execute(
        "libreoffice",
        [
          `-env:UserInstallation=file://${join(dir, "profile")}`,
          "--headless",
          "--convert-to",
          "pdf",
          "--outdir",
          dir,
          scope.path(task.path),
        ],
        { timeout: 60000, maxBuffer: 1024 * 1024 },
      );
      const output = readdirSync(dir).find((p) => p.endsWith(".pdf"));
      if (!output) throw new Error("Office conversion did not produce a PDF");
      const path = `documents/generated/${randomUUID()}.pdf`;
      writeFileSync(scope.parent(path), readFileSync(join(dir, output)), {
        flag: "wx",
      });
      const check = await inspect(scope, path);
      return {
        path,
        text: check.pages.map((p: any) => p.text).join("\n"),
        warnings: check.warnings,
        draft: true,
        provenance: { template: task.path, conversion: "office-to-pdf" },
      };
    } catch (error) {
      if ((error as any).code !== "ENOENT") throw error;
      const extracted = await inspect(scope, task.path);
      const text = extracted.pages.map((p: any) => p.text).join("\n");
      const pdf = await makePdf("Document content preview\n\n" + text);
      const path = `documents/generated/${randomUUID()}.pdf`;
      writeFileSync(scope.parent(path), await pdf.save(), { flag: "wx" });
      return {
        path,
        text,
        warnings: [
          "Normalized content preview: original Office layout and formula recalculation are not reproduced.",
        ],
        draft: true,
        provenance: {
          template: task.path,
          conversion: "normalized-content-preview",
        },
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (task.operation === "inspect") {
    if (!task.path) throw new Error("path required");
    return inspect(scope, task.path);
  }
  if (!task.title?.trim()) throw new Error("Document title required");
  let format = task.format ?? (task.path ? extname(task.path).slice(1) : "pdf");
  if (["png", "jpg", "jpeg", "tif", "tiff"].includes(format)) format = "pdf";
  if (!["pdf", "docx", "xlsx"].includes(format))
    throw new Error("Output format must be pdf, docx or xlsx");
  const path = `documents/generated/${randomUUID()}.${format}`;
  const target = scope.parent(path);
  let buffer: Uint8Array;
  const values = task.values ?? {};
  let replacements = 0;
  if (format === "docx") {
    let zip: JSZip;
    if (task.path) {
      validateArchiveBudget(readFileSync(scope.path(task.path)));
      zip = await JSZip.loadAsync(readFileSync(scope.path(task.path)));
      // Join split Word runs within each paragraph before replacing placeholders.
      for (const name of Object.keys(zip.files).filter((n) =>
        /^word\/(document|header\d+|footer\d+)\.xml$/.test(n),
      )) {
        let body = await zip.file(name)!.async("string");
        body = body.replace(
          /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g,
          (paragraph) => {
            const runs = [
              ...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g),
            ];
            const joined = runs.map((m) => m[1]).join("");
            let result = joined;
            for (const item of task.replacements ?? []) {
              if (!item.find)
                throw new Error("Replacement search text must not be empty");
              if (result.includes(xml(item.find))) {
                replacements++;
                result = result.split(xml(item.find)).join(xml(item.replace));
              }
            }
            for (const [key, value] of Object.entries(values)) {
              const token = `{{${key}}}`;
              if (result.includes(token)) {
                replacements++;
                result = result.split(token).join(xml(value));
              }
            }
            if (result === joined) return paragraph;
            let first = true;
            return paragraph.replace(
              /(<w:t(?:\s[^>]*)?>)[\s\S]*?(<\/w:t>)/g,
              (_, a, b) => {
                const text = first ? result : "";
                first = false;
                return a + text + b;
              },
            );
          },
        );
        zip.file(name, body);
      }
      if (!replacements)
        throw new Error(
          "No matching DOCX fields or exact replacement text found. Inspect the document and specify replacements; original retained.",
        );
    } else {
      zip = new JSZip();
      zip.file(
        "[Content_Types].xml",
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      );
      zip
        .folder("_rels")!
        .file(
          ".rels",
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        );
      zip.file(
        "word/document.xml",
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[
          task.title,
          task.text ?? "",
          ...Object.entries(values).map(([k, v]) => `${k}: ${v}`),
        ]
          .join("\n")
          .split("\n")
          .map(
            (l) =>
              `<w:p><w:r><w:t xml:space="preserve">${xml(l)}</w:t></w:r></w:p>`,
          )
          .join(
            "",
          )}${(task.tables ?? []).map((table) => "<w:tbl>" + [table.headers, ...table.rows].map((row) => "<w:tr>" + row.map((cell) => "<w:tc><w:p><w:r><w:t>" + xml(cell) + "</w:t></w:r></w:p></w:tc>").join("") + "</w:tr>").join("") + "</w:tbl>").join("")}</w:body></w:document>`,
      );
    }
    buffer = await zip.generateAsync({ type: "uint8array" });
  } else if (format === "xlsx") {
    const wb = new ExcelJS.Workbook();
    if (task.path) {
      validateArchiveBudget(readFileSync(scope.path(task.path)));
      await wb.xlsx.readFile(scope.path(task.path));
    } else {
      const sheet = wb.addWorksheet("Summary");
      sheet.addRow([task.title]);

      for (const [k, v] of Object.entries(values)) sheet.addRow([k, v]);
      if (task.text) sheet.addRow([task.text]);
      for (const table of task.tables ?? []) {
        sheet.addRow(table.headers);
        for (const row of table.rows) sheet.addRow(row);
      }
    }
    for (const cell of task.cells ?? []) {
      const sheet = wb.getWorksheet(cell.sheet);
      if (!sheet || !/^[A-Z]{1,3}[1-9]\d{0,5}$/.test(cell.cell))
        throw new Error("Invalid spreadsheet cell");
      if (sheet.getCell(cell.cell).formula)
        throw new Error("Refusing to overwrite an existing formula");
      sheet.getCell(cell.cell).value = cell.value;
    }
    wb.calcProperties.fullCalcOnLoad = true;
    buffer = new Uint8Array(await wb.xlsx.writeBuffer());
  } else {
    let pdf: PDFDocument;
    if (task.path) {
      const ext = extname(task.path).toLowerCase();
      if (ext === ".pdf")
        pdf = await PDFDocument.load(readFileSync(scope.path(task.path)));
      else if ([".png", ".jpg", ".jpeg"].includes(ext)) {
        pdf = await PDFDocument.create();
        const image =
          ext === ".png"
            ? await pdf.embedPng(readFileSync(scope.path(task.path)))
            : await pdf.embedJpg(readFileSync(scope.path(task.path)));
        const page = pdf.addPage([image.width * 0.6, image.height * 0.6]);
        page.drawImage(image, {
          x: 0,
          y: 0,
          width: page.getWidth(),
          height: page.getHeight(),
        });
      } else
        throw new Error("Use the original Office format or create a new PDF");
      const form = pdf.getForm();
      for (const [name, value] of Object.entries(values)) {
        form.getTextField(name).setText(value);
        replacements++;
      }
      for (const area of task.overlays ?? []) {
        const page = pdf.getPages()[area.page - 1];
        if (
          !page ||
          !Number.isFinite(area.x) ||
          !Number.isFinite(area.y) ||
          area.x < 0 ||
          area.y < 0 ||
          area.x > page.getWidth() ||
          area.y > page.getHeight()
        )
          throw new Error("Invalid PDF overlay coordinates");
        page.drawText(plain(area.value), {
          x: area.x,
          y: area.y,
          size: 10,
          color: rgb(0, 0, 0.35),
        });
        replacements++;
      }
      if (!replacements)
        throw new Error(
          "No PDF fields or overlays specified; inspect the document first",
        );
    } else
      pdf = await makePdf(
        `${task.title}\n\n${task.text ?? ""}\n${Object.entries(values)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")}`,
      );
    // Review status is carried by version metadata and delivery caption; preserve the supplied layout.
    buffer = await pdf.save();
  }
  writeFileSync(target, buffer, { flag: "wx", mode: 0o600 });
  try {
    const check = await inspect(scope, path);
    if (!check.pages?.some((p: any) => p.text.trim()))
      throw new Error("Generated document has no readable content");
    return {
      path,
      text: check.pages.map((p: any) => p.text).join("\n"),
      warnings: check.warnings ?? [],
      provenance: {
        template: task.path ?? null,
        values,
        cells: task.cells,
        overlays: task.overlays,
      },
      draft: true,
    };
  } catch (e) {
    rmSync(target, { force: true });
    throw e;
  }
}
if (!isMainThread && workerData?.task) {
  processDocument(new CompanyScope(workerData.root), workerData.task).then(
    (result) => parentPort!.postMessage({ result }),
    (e) => parentPort!.postMessage({ error: String(e.message ?? e) }),
  );
}
