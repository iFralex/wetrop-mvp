import { readFile } from "node:fs/promises";
import type { DocumentHeading, DocumentPage } from "../types.ts";

export async function readTextDocument(path: string, extension: string): Promise<{ pages: DocumentPage[]; headings: DocumentHeading[]; warnings: string[] }> {
  const bytes = await readFile(path);
  if (looksBinary(bytes)) throw new Error("file does not look like UTF-8 text");
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (extension === ".html" || extension === ".htm") text = htmlToText(text);
  const headings = markdownHeadings(text, extension);
  return { pages: [{ number: 1, text }], headings, warnings: [] };
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const b of sample) if (b < 9 || (b > 13 && b < 32)) controls++;
  return sample.length > 0 && controls / sample.length > 0.02;
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToText(html: string): string {
  return decodeXmlEntities(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function markdownHeadings(text: string, extension: string): DocumentHeading[] {
  if (![".md", ".markdown", ".mdx", ".rst"].includes(extension)) return [];
  const headings: DocumentHeading[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) headings.push({ level: match[1].length, text: match[2], page: 1, offset });
    offset += line.length + 1;
  }
  return headings;
}
