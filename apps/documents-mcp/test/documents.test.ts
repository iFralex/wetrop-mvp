import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import { clearDocumentCache } from "../src/cache.ts";
import { extractDocument } from "../src/extraction.ts";
import { loadDocumentEmbedConfig } from "../src/embed-config.ts";
import { readDocumentPage } from "../src/output-budget.ts";
import { resolveSafeDocument } from "../src/security.ts";
import { chunkDocument, searchDocument } from "../src/search.ts";
import type { ExtractedDocument } from "../src/types.ts";

test("text extraction preserves markdown headings and bounded reads expose a cursor", async () => {
  clearDocumentCache();
  const dir = mkdtempSync(join(tmpdir(), "documents-mcp-"));
  const path = join(dir, "notes.md");
  writeFileSync(path, `# Intro\n\n${"alpha ".repeat(3_000)}\n## End\nDone.`);
  const document = await extractDocument(path);
  assert.deepEqual(document.headings.map((heading) => heading.text), ["Intro", "End"]);
  const first = readDocumentPage(document, { max_chars: 1_000 });
  assert.equal(first.content.length, 1_000);
  assert.equal(first.navigation.hasMore, true);
  assert.match(first.navigation.nextCursor ?? "", /^p1:o1000@[a-f0-9]{16}$/);
  const second = readDocumentPage(document, { cursor: first.navigation.nextCursor, max_chars: 50_000 });
  assert.ok(second.content.length <= 12_000);
});

test("lexical document search returns compact cursors without embeddings", async () => {
  const document = fakeDocument([
    "The introduction discusses ordinary matters.",
    "Termination requires thirty days notice and incurs an early exit penalty.",
  ]);
  const result = await searchDocument(document, "early exit penalty", { max_results: 5, context_chars: 160 }, null);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].page, 2);
  assert.match(result.matches[0].excerpt, /early exit penalty/i);
  assert.match(result.matches[0].cursor, /^p2:o0@[a-f0-9]{16}$/);
  assert.equal(result.search.semantic, "disabled");
});

test("semantic search uses shared embeddings, fuses rankings, and caches document vectors", async () => {
  const document = fakeDocument(["automobile vehicle transport", "banana fruit yellow"]);
  let batchCalls = 0;
  const deps = {
    embedTexts: async (texts: string[]) => {
      batchCalls++;
      return texts.map((text) => text.includes("banana") ? [0, 1] : [1, 0]);
    },
    embedText: async () => [0, 1],
  };
  const config = { endpoint: "http://example.test", model: "test" };
  const first = await searchDocument(document, "tropical produce", {}, config, deps);
  const second = await searchDocument(document, "yellow food", {}, config, deps);
  assert.equal(first.matches[0].page, 2);
  assert.equal(first.search.semantic, "full");
  assert.equal(second.matches[0].page, 2);
  assert.equal(batchCalls, 1);
});

test("chunking covers long pages with overlap and stable page cursors", () => {
  const document = fakeDocument(["sentence. ".repeat(500)]);
  const chunks = chunkDocument(document);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].offset, 0);
  assert.ok(chunks[1].offset < chunks[0].text.length);
  assert.ok(chunks.every((chunk) => chunk.id === `p${chunk.page}:o${chunk.offset}`));
});

test("multi-page reads stop at the requested page budget and finish without a stale cursor", () => {
  const document = fakeDocument(["one", "two", "three"]);
  const first = readDocumentPage(document, { max_chars: 1_000, max_pages: 2 });
  assert.equal(first.selection.pagesRead, 2);
  assert.match(first.navigation.nextCursor!, /^p3:o0@[a-f0-9]{16}$/);
  const last = readDocumentPage(document, { cursor: first.navigation.nextCursor, max_chars: 1_000 });
  assert.equal(last.navigation.hasMore, false);
  assert.equal(last.navigation.nextCursor, null);
  assert.throws(() => readDocumentPage(document, { page: 99 }), /outside/);
});

test("security checks the canonical target of a symlink and enforces file limits", () => {
  const dir = mkdtempSync(join(tmpdir(), "documents-security-"));
  const secret = join(dir, ".env");
  const link = join(dir, "innocent.txt");
  writeFileSync(secret, "TOKEN=secret");
  symlinkSync(secret, link);
  assert.throws(() => resolveSafeDocument(link), /blocked/);
  const large = join(dir, "large.txt");
  writeFileSync(large, "12345");
  assert.throws(() => resolveSafeDocument(large, { DOCUMENT_MAX_BYTES: "4" }), /too large/);
});

test("PPTX extraction treats each slide as a page", async () => {
  clearDocumentCache();
  const dir = mkdtempSync(join(tmpdir(), "documents-pptx-"));
  const path = join(dir, "deck.pptx");
  const zip = new JSZip();
  zip.file("ppt/slides/slide2.xml", "<p:sld><a:t>Second slide</a:t></p:sld>");
  zip.file("ppt/slides/slide1.xml", "<p:sld><a:t>First slide</a:t><a:t>Detail</a:t></p:sld>");
  writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }));
  const document = await extractDocument(path);
  assert.deepEqual(document.pages.map((page) => page.text), ["First slide\nDetail", "Second slide"]);
});

test("PDF extraction returns page text", async () => {
  clearDocumentCache();
  const dir = mkdtempSync(join(tmpdir(), "documents-pdf-"));
  const path = join(dir, "sample.pdf");
  writeFileSync(path, minimalPdf("Hello PDF reader"));
  const document = await extractDocument(path);
  assert.equal(document.pages.length, 1);
  assert.match(document.pages[0].text, /Hello PDF reader/);
});

test("embedding config attributes gateway usage to documents-mcp", () => {
  const config = loadDocumentEmbedConfig({ DOCUMENT_EMBED_ENDPOINT: "http://127.0.0.1:4000/v1/embeddings" });
  assert.equal(config?.extraHeaders?.["x-usage-service"], "documents-mcp");
  assert.equal(config?.extraHeaders?.["x-usage-action"], "search-embed");
});

function fakeDocument(pages: string[]): ExtractedDocument {
  return {
    path: "/tmp/fake.txt", name: "fake.txt", format: "txt", size: pages.join("").length,
    modifiedAt: new Date(0).toISOString(), cacheKey: "fake", headings: [], warnings: [],
    pages: pages.map((text, index) => ({ number: index + 1, text })),
  };
}

function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}

test('versioned cursors reject a document edited between reads', () => {
  const doc=fakeDocument(['x'.repeat(1000)]);
  const first=readDocumentPage(doc,{max_chars:200});
  assert.throws(()=>readDocumentPage({...doc,cacheKey:'changed'}, {cursor:first.navigation.nextCursor}),/older/);
});

test('a previously failed vector is retried on a subsequent search', async () => {
  const doc=fakeDocument(['alpha']);let available=false;
  const config={endpoint:'http://example.test',model:'test'};
  const deps={embedText:async()=>[1,0],embedTexts:async()=>[available?[1,0]:null]};
  await searchDocument(doc,'alpha',{},config,deps);
  available=true;
  const result=await searchDocument(doc,'different',{},config,deps);
  assert.equal(result.matches.length,1);
});

test('compressed Office files are rejected before inflation when directory size exceeds budget',async()=>{
  const {validateArchiveBudget}=await import('../src/archive-budget.ts');
  const zip=new JSZip();zip.file('word/document.xml','x'.repeat(10000));
  const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  assert.ok(bytes.length<1000);
  assert.throws(()=>validateArchiveBudget(bytes,1000),/decompressed/);
});

test('document cache enforces aggregate estimated bytes rather than only entry count',async()=>{
  const {cachedDocument,cacheDocument}=await import('../src/cache.ts');
  const previous=process.env.DOCUMENT_CACHE_MAX_BYTES;process.env.DOCUMENT_CACHE_MAX_BYTES='1024';
  try {clearDocumentCache();const doc=fakeDocument(['x'.repeat(1000)]);cacheDocument(doc);assert.equal(cachedDocument(doc.cacheKey),undefined);}
  finally {if(previous===undefined)delete process.env.DOCUMENT_CACHE_MAX_BYTES;else process.env.DOCUMENT_CACHE_MAX_BYTES=previous;clearDocumentCache();}
});
