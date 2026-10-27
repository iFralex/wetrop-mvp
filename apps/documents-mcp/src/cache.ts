import type { ExtractedDocument } from "./types.ts";

const MAX_ENTRIES = 8;
const entries = new Map<string, ExtractedDocument>();

export function cachedDocument(key: string): ExtractedDocument | undefined {
  const value = entries.get(key);
  if (!value) return undefined;
  entries.delete(key);
  entries.set(key, value);
  return value;
}

export function cacheDocument(document: ExtractedDocument): ExtractedDocument {
  entries.set(document.cacheKey, document);
  const maxBytes = Math.min(Math.max(Number(process.env.DOCUMENT_CACHE_MAX_BYTES) || 64 * 1024 * 1024, 1024), 256 * 1024 * 1024);
  const size = (item: ExtractedDocument) => item.pages.reduce((n, page) => n + page.text.length * 2, 0)
    + (item.chunks?.reduce((n, chunk) => n + chunk.text.length * 2, 0) ?? 0)
    + (item.embeddings?.reduce((n, vector) => n + (vector?.length ?? 0) * 8, 0) ?? 0);
  while (entries.size > MAX_ENTRIES || [...entries.values()].reduce((n, entry) => n + size(entry), 0) > maxBytes) {
    entries.delete(entries.keys().next().value as string);
  }
  return document;
}

export function clearDocumentCache(): void {
  entries.clear();
}
