import { readFile } from "node:fs/promises";
import type { DocumentPage } from "../types.ts";

export async function readPdfDocument(path: string): Promise<{ pages: DocumentPage[]; warnings: string[] }> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = new Uint8Array(await readFile(path));
  const task = getDocument({ data: bytes, useSystemFonts: true });
  const pdf = await task.promise;
  const pages: DocumentPage[] = [];
  try {
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str;
        text += "hasEOL" in item && item.hasEOL ? "\n" : " ";
      }
      pages.push({ number, text: normalizePdfText(text) });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  const warnings = pages.every((page) => !page.text.trim()) ? ["no_extractable_text: the PDF may be scanned or image-only"] : [];
  return { pages, warnings };
}

function normalizePdfText(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
