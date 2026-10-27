import { fetchEmbedding, fetchEmbeddingBatch, type EmbeddingConfig } from "@steward/embedding";

export async function embedText(
  text: string,
  cfg: EmbeddingConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<number[] | null> {
  const result = await fetchEmbedding(text, cfg, { fetch: fetchImpl, isNetworkError: (e) => e instanceof TypeError });
  return result.vector;
}

export async function embedTexts(
  texts: string[],
  cfg: EmbeddingConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<(number[] | null)[]> {
  const r = await fetchEmbeddingBatch(texts, cfg, { fetch: fetchImpl, isNetworkError: (e) => e instanceof TypeError });
  return r.vectors;
}
