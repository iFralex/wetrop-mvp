import { validateArchiveBudget } from "../archive-budget.ts";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import mammoth from "mammoth";
import type { DocumentPage } from "../types.ts";
import { decodeXmlEntities } from "./text.ts";

export async function readDocx(path: string): Promise<{ pages: DocumentPage[]; warnings: string[] }> {
  const buffer = await readFile(path);
  validateArchiveBudget(buffer);
  const result = await mammoth.extractRawText({ buffer });
  return { pages: [{ number: 1, text: result.value.replace(/\r\n?/g, "\n").trim() }], warnings: result.messages.map((m) => m.message) };
}

export async function readPptx(path: string): Promise<{ pages: DocumentPage[]; warnings: string[] }> {
  const buffer = await readFile(path);
  validateArchiveBudget(buffer);
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  const pages: DocumentPage[] = [];
  for (const name of slideNames) {
    const xml = await zip.file(name)!.async("string");
    const text = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1])).join("\n");
    pages.push({ number: slideNumber(name), text });
  }
  return { pages, warnings: [] };
}

export async function readOdt(path: string): Promise<{ pages: DocumentPage[]; warnings: string[] }> {
  const buffer = await readFile(path);
  validateArchiveBudget(buffer);
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file("content.xml");
  if (!file) throw new Error("invalid ODT: content.xml missing");
  const xml = await file.async("string");
  const text = decodeXmlEntities(xml
    .replace(/<text:(line-break|p|h)[^>]*>/g, "\n")
    .replace(/<\/text:(p|h)>/g, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { pages: [{ number: 1, text }], warnings: [] };
}

export async function readRtf(path: string): Promise<{ pages: DocumentPage[]; warnings: string[] }> {
  const raw = await readFile(path, "utf8");
  const text = raw
    .replace(/\\par[d]?\b/g, "\n")
    .replace(/\\'[0-9a-f]{2}/gi, (hex) => Buffer.from(hex.slice(2), "hex").toString("latin1"))
    .replace(/\\u(-?\d+)\??/g, (_, n: string) => String.fromCharCode((Number(n) + 65536) % 65536))
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n").trim();
  return { pages: [{ number: 1, text }], warnings: ["RTF formatting was removed"] };
}

function slideNumber(name: string): number {
  return Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}
