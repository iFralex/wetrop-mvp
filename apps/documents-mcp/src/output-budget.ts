import { createHash } from "node:crypto";
import type { ExtractedDocument, ReadCursor } from "./types.ts";

export const DEFAULT_READ_CHARS = 6_000;
export const MAX_READ_CHARS = 12_000;
export const DEFAULT_READ_PAGES = 1;
export const MAX_READ_PAGES = 3;

export function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

export function parseCursor(value: unknown): ReadCursor | null {
  if (typeof value !== "string" || !value) return null;
  const match = /^p(\d+):o(\d+)(?:@([a-f0-9]{16}))?$/.exec(value);
  if (!match) throw new Error("cursor must come from a previous document_read result");
  return { page: Number(match[1]), offset: Number(match[2]), ...(match[3] ? { version: match[3] } : {}) };
}

export function readDocumentPage(
  document: ExtractedDocument,
  args: { page?: unknown; cursor?: unknown; max_chars?: unknown; max_pages?: unknown },
) {
  const cursor = parseCursor(args.cursor);
  if (cursor && cursor.version !== documentVersion(document)) throw new Error('Cursor belongs to an older or unversioned document; repeat document_info/search');
  if (cursor && args.page !== undefined) throw new Error("provide page or cursor, not both");
  const requestedPage = cursor?.page ?? boundedInteger(args.page, 1, 1, Number.MAX_SAFE_INTEGER);
  const page = requestedPage;
  const offset = cursor?.offset ?? 0;
  const maxChars = boundedInteger(args.max_chars, DEFAULT_READ_CHARS, 200, MAX_READ_CHARS);
  const maxPages = boundedInteger(args.max_pages, DEFAULT_READ_PAGES, 1, MAX_READ_PAGES);
  if (page > document.pages.length) throw new Error(`page ${page} is outside this ${document.pages.length}-page document`);

  let remaining = maxChars;
  let currentPage = page;
  let currentOffset = offset;
  let pagesRead = 0;
  const pieces: string[] = [];
  let nextCursor: string | null = null;

  while (currentPage <= document.pages.length && pagesRead < maxPages && remaining > 0) {
    const source = document.pages[currentPage - 1]?.text ?? "";
    if (currentOffset > source.length) throw new Error(`cursor offset is outside page ${currentPage}`);
    const marker = document.pages.length > 1 ? `[Page ${currentPage}]\n` : "";
    const separatorLength = pieces.length ? 2 : 0;
    if (separatorLength + marker.length >= remaining) break;
    const room = remaining - separatorLength - marker.length;
    const content = source.slice(currentOffset, currentOffset + room);
    pieces.push(marker + content);
    remaining -= separatorLength + marker.length + content.length;
    pagesRead++;
    if (currentOffset + content.length < source.length) {
      nextCursor = documentCursor(document, currentPage, currentOffset + content.length);
      break;
    }
    currentPage++;
    currentOffset = 0;
    nextCursor = currentPage <= document.pages.length ? documentCursor(document, currentPage, 0) : null;
  }

  const content = pieces.join("\n\n");
  const totalChars = document.pages.reduce((sum, item) => sum + item.text.length, 0);
  return {
    path: document.path,
    name: document.name,
    format: document.format,
    content,
    selection: { page, offset, pagesRead },
    navigation: { hasMore: nextCursor !== null, nextCursor },
    stats: {
      totalPages: document.pages.length,
      totalChars,
      returnedChars: content.length,
      truncated: nextCursor !== null,
    },
    ...(document.warnings.length ? { warnings: document.warnings } : {}),
  };
}

export function documentVersion(document: ExtractedDocument): string {
  return createHash('sha256').update(document.cacheKey).digest('hex').slice(0, 16);
}
export function documentCursor(document: ExtractedDocument, page: number, offset: number): string {
  return `p${page}:o${offset}@${documentVersion(document)}`;
}
