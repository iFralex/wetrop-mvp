import { Worker } from "node:worker_threads";
import { cachedDocument, cacheDocument } from "./cache.ts";
import { ARCHIVE_DOCUMENT_EXTENSIONS, resolveSafeDocument, TEXT_EXTENSIONS } from "./security.ts";
import type { DocumentHeading, ExtractedDocument } from "./types.ts";
import { readTextDocument } from "./readers/text.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_WARNINGS = 10;
const MAX_WARNING_CHARS = 300;

export async function extractDocument(inputPath: string): Promise<ExtractedDocument> {
  const safe = resolveSafeDocument(inputPath);
  const cached = cachedDocument(safe.cacheKey);
  if (cached) return cached;
  const extracted = await extractInWorker(safe.path, safe.extension, extractionTimeout());
  if (resolveSafeDocument(inputPath).cacheKey !== safe.cacheKey) throw new Error('Document changed during extraction; retry with the current file');
  return cacheDocument({
    ...safe,
    format: safe.extension.slice(1),
    pages: extracted.pages,
    headings: "headings" in extracted ? extracted.headings as DocumentHeading[] : [],
    warnings: extracted.warnings.slice(0, MAX_WARNINGS).map((warning) => warning.slice(0, MAX_WARNING_CHARS)),
  });
}

export async function extractByType(path: string, extension: string) {
  if (TEXT_EXTENSIONS.has(extension)) return readTextDocument(path, extension);
  if (extension === ".pdf") return (await import("./readers/pdf.ts")).readPdfDocument(path);
  if (extension === ".rtf") return (await import("./readers/office.ts")).readRtf(path);
  if (ARCHIVE_DOCUMENT_EXTENSIONS.has(extension)) {
    const { readDocx, readPptx, readOdt } = await import("./readers/office.ts");
    if (extension === ".docx") return readDocx(path);
    if (extension === ".pptx") return readPptx(path);
    return readOdt(path);
  }
  throw new Error(`unsupported document type '${extension}'`);
}

function extractionTimeout(): number {
  const configured = Number(process.env.DOCUMENT_EXTRACT_TIMEOUT_MS);
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 1_000), 60_000) : DEFAULT_TIMEOUT_MS;
}

function extractInWorker(path: string, extension: string, timeoutMs: number): Promise<Awaited<ReturnType<typeof extractByType>>> {
  return new Promise((resolve, reject) => {
    const bundled = import.meta.url.endsWith('.js');
    const worker = new Worker(new URL(bundled ? './documents-worker.js' : './extraction-worker.ts', import.meta.url), {
      workerData: { path, extension }, resourceLimits: { maxOldGenerationSizeMb: Math.min(Math.max(Number(process.env.DOCUMENT_WORKER_HEAP_MB) || 256, 64), 512) },
    });
    let settled = false;
    const finish = (error?: Error, result?: Awaited<ReturnType<typeof extractByType>>) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error('document extraction timed out; parser worker terminated')), timeoutMs);
    worker.once('message', message => finish(message.error ? new Error(message.error) : undefined, message.result));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!settled) finish(new Error(`Document parser exited without a result (${code})`)); });
  });
}
