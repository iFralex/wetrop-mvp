import { embedText as sharedEmbedText, embedTexts as sharedEmbedTexts, rrf } from "@steward/search";
import type { EmbeddingConfig } from "@steward/embedding";
import type { DocumentChunk, ExtractedDocument } from "./types.ts";
import { cacheDocument } from "./cache.ts";
import { documentCursor, boundedInteger } from "./output-budget.ts";

const CHUNK_CHARS = 1_800;
const CHUNK_OVERLAP = 200;
const MAX_EMBED_CHUNKS = 256;
const CANDIDATES = 50;

export async function searchDocument(
  document: ExtractedDocument,
  query: string,
  args: { max_results?: unknown; context_chars?: unknown },
  embedConfig: EmbeddingConfig | null,
  deps: {
    embedText?: typeof sharedEmbedText;
    embedTexts?: typeof sharedEmbedTexts;
  } = {},
) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) throw new Error("query is required");
  const limit = boundedInteger(args.max_results, 5, 1, 10);
  const contextChars = boundedInteger(args.context_chars, 300, 100, 800);
  const chunks = document.chunks ??= chunkDocument(document);
  const lexical = chunks
    .map((chunk) => ({ chunk, score: lexicalScore(chunk.text, normalizedQuery) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
    .slice(0, CANDIDATES)
    .map((entry) => entry.chunk.id);

  let semantic: string[] = [];
  const embedOne = deps.embedText ?? sharedEmbedText;
  const embedMany = deps.embedTexts ?? sharedEmbedTexts;
  let semanticMode: "disabled" | "full" | "sampled" | "partial" | "unavailable" = embedConfig ? "unavailable" : "disabled";
  if (embedConfig && chunks.length) {
    const modelKey = JSON.stringify([embedConfig.endpoint, embedConfig.model, embedConfig.outputDimensionality]);
    if (document.embeddingModelKey !== modelKey) {
      document.embeddings = undefined;
      document.embeddingModelKey = modelKey;
    }
    document.embeddingChunks ??= sampleChunks(chunks, MAX_EMBED_CHUNKS);
    if (!document.embeddings) document.embeddings = await embedInBatches(document.embeddingChunks.map((chunk) => chunk.text), embedConfig, embedMany);
    const missing = document.embeddings.flatMap((vector, index) => vector ? [] : [index]);
    if (missing.length) {
      const retried = await embedInBatches(missing.map(index => document.embeddingChunks![index].text), embedConfig, embedMany);
      missing.forEach((index, at) => { document.embeddings![index] = retried[at]; });
    }
    const queryVector = await embedOne(normalizedQuery, embedConfig);
    if (queryVector) {
      semantic = document.embeddingChunks
        .map((chunk, index) => ({ chunk, score: cosine(queryVector, document.embeddings?.[index]) }))
        .filter((entry) => Number.isFinite(entry.score))
        .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
        .slice(0, CANDIDATES)
        .map((entry) => entry.chunk.id);
      const available = document.embeddings.filter(vector => vector && vector.length === queryVector.length).length;
      semanticMode = available === 0 ? 'unavailable' : available < document.embeddingChunks.length ? 'partial'
        : document.embeddingChunks.length === chunks.length ? 'full' : 'sampled';
    }
  }

  const rankings = [lexical, semantic].filter((ranking) => ranking.length > 0);
  const orderedIds = rankings.length > 1 ? rrf(rankings).map((entry) => entry.id) : (rankings[0] ?? []);
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const matches = orderedIds.slice(0, limit).flatMap((id) => {
    const chunk = byId.get(id);
    if (!chunk) return [];
    return [{
      page: chunk.page,
      offset: chunk.offset,
      excerpt: excerpt(chunk.text, normalizedQuery, contextChars),
      cursor: documentCursor(document, chunk.page, chunk.offset),
    }];
  });
  cacheDocument(document);
  return {
    path: document.path,
    name: document.name,
    format: document.format,
    query: normalizedQuery,
    matches,
    search: { lexical: true, semantic: semanticMode, totalChunks: chunks.length, embeddedChunks: document.embeddings?.filter(Boolean).length ?? 0, selectedChunks: document.embeddingChunks?.length ?? 0 },
    truncated: orderedIds.length > limit,
    ...(semanticMode === "partial" ? { warning: "Some document embeddings remain unavailable; lexical search covered the full document." } : {}),
    ...(semanticMode === "sampled" ? { warning: `Semantic search sampled ${document.embeddingChunks?.length} of ${chunks.length} chunks; lexical search covered the full document.` } : {}),
    ...(document.warnings.length ? { warnings: document.warnings } : {}),
  };
}

export function chunkDocument(document: ExtractedDocument): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  for (const page of document.pages) {
    let offset = 0;
    while (offset < page.text.length) {
      let end = Math.min(page.text.length, offset + CHUNK_CHARS);
      if (end < page.text.length) {
        const boundary = Math.max(page.text.lastIndexOf("\n", end), page.text.lastIndexOf(". ", end));
        if (boundary > offset + CHUNK_CHARS * 0.6) end = boundary + 1;
      }
      const text = page.text.slice(offset, end).trim();
      if (text) chunks.push({ id: `p${page.number}:o${offset}`, page: page.number, offset, text });
      if (end >= page.text.length) break;
      offset = Math.max(offset + 1, end - CHUNK_OVERLAP);
    }
  }
  return chunks;
}

function sampleChunks(chunks: DocumentChunk[], max: number): DocumentChunk[] {
  if (chunks.length <= max) return chunks;
  const out: DocumentChunk[] = [];
  for (let i = 0; i < max; i++) out.push(chunks[Math.floor(i * (chunks.length - 1) / (max - 1))]);
  return out;
}

async function embedInBatches(
  texts: string[],
  config: EmbeddingConfig,
  embedMany: typeof sharedEmbedTexts,
): Promise<Array<number[] | null>> {
  const result: Array<number[] | null> = [];
  for (let offset = 0; offset < texts.length; offset += 64) {
    result.push(...await embedMany(texts.slice(offset, offset + 64), config));
  }
  return result;
}

function tokens(value: string): string[] {
  return value.toLocaleLowerCase().normalize("NFKD").replace(/\p{M}/gu, "")
    .match(/[\p{L}\p{N}]{2,}/gu) ?? [];
}

function lexicalScore(text: string, query: string): number {
  const haystack = normalizedText(text);
  const normalizedPhrase = normalizedText(query);
  const terms = [...new Set(tokens(query))];
  if (!terms.length) return 0;
  let score = haystack.includes(normalizedPhrase) ? 8 : 0;
  for (const term of terms) {
    let count = 0;
    let at = haystack.indexOf(term);
    while (at >= 0 && count < 10) { count++; at = haystack.indexOf(term, at + term.length); }
    if (count) score += 1 + Math.log2(count + 1);
  }
  return score;
}

function cosine(a: number[], b: number[] | null | undefined): number {
  if (!b || a.length !== b.length || !a.length) return Number.NaN;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : Number.NaN;
}

function excerpt(text: string, query: string, maxChars: number): string {
  const lower = normalizedText(text);
  const normalizedQuery = normalizedText(query);
  const terms = tokens(query);
  let hit = lower.indexOf(normalizedQuery);
  if (hit < 0) hit = terms.reduce((best, term) => {
    const found = lower.indexOf(term);
    return found >= 0 && (best < 0 || found < best) ? found : best;
  }, -1);
  const center = hit >= 0 ? hit : 0;
  const start = Math.max(0, Math.min(text.length - maxChars, center - Math.floor(maxChars / 3)));
  const body = text.slice(start, start + maxChars).trim();
  return `${start > 0 ? "…" : ""}${body}${start + maxChars < text.length ? "…" : ""}`;
}

function normalizedText(value: string): string {
  return value.toLocaleLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
}
