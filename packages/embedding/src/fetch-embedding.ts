import type { EmbeddingConfig, EmbeddingDeps, EmbeddingResult } from "./types.ts";
import {
  isGoogleEmbeddingConfig,
  isDoubaoMultimodalEmbeddingConfig,
  googleEmbeddingEndpoint,
  volcengineEmbeddingEndpoint,
  isLocalOrPrivateHttpEndpoint,
  isSafeExtraHeader,
  googleEmbeddingBody,
  doubaoMultimodalEmbeddingBody,
  isNonEmptyNumberArray,
  looksLikeOversizeError,
} from "./providers.ts";

export interface EmbeddingBatchResult {
  vectors: (number[] | null)[];
  error?: string;
}

/**
 * JSON permits escaped lone UTF-16 surrogates, but downstream Python clients
 * cannot encode them as UTF-8. Preserve valid pairs and replace malformed
 * code units before sending text to an embedding provider.
 */
function toWellFormedText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i++;
      } else {
        out += "\ufffd";
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      out += "\ufffd";
    } else {
      out += text[i];
    }
  }
  return out;
}

export async function fetchEmbedding(
  text: string,
  cfg: EmbeddingConfig,
  deps: EmbeddingDeps,
  maxRetries = 3,
): Promise<EmbeddingResult> {
  if (!cfg.endpoint) return { vector: null }

  const isGoogleNative = isGoogleEmbeddingConfig(cfg)
  const isDoubaoMultimodal = isDoubaoMultimodalEmbeddingConfig(cfg)
  const endpoint = isGoogleNative
    ? googleEmbeddingEndpoint(cfg)
    : volcengineEmbeddingEndpoint(cfg)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(deps.originHeader && isLocalOrPrivateHttpEndpoint(endpoint) ? deps.originHeader() : {}),
  }
  if (cfg.apiKey) {
    if (isGoogleNative) {
      headers["x-goog-api-key"] = cfg.apiKey
    } else {
      headers.Authorization = `Bearer ${cfg.apiKey}`
    }
  }
  if (cfg.extraHeaders) {
    for (const [k, v] of Object.entries(cfg.extraHeaders)) {
      const name = k.trim()
      const value = v.trim()
      if (!isSafeExtraHeader(name, value)) continue
      headers[name] = value
    }
  }

  const httpFetch = deps.fetch
  let current = toWellFormedText(text)
  let attempts = 0
  while (attempts <= maxRetries) {
    attempts++
    try {
      const resp = await httpFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(
          isGoogleNative
            ? googleEmbeddingBody(cfg.model, current, cfg.outputDimensionality)
            : isDoubaoMultimodal
              ? doubaoMultimodalEmbeddingBody(cfg.model, current)
              : { model: cfg.model, input: current },
        ),
      })

      if (resp.ok) {
        const data = await resp.json()
        const embedding = isGoogleNative
          ? (data as any)?.embedding?.values ?? null
          : isDoubaoMultimodal
            ? (data as any)?.data?.embedding ?? null
            : (data as any)?.data?.[0]?.embedding ?? null
        if (isNonEmptyNumberArray(embedding)) {
          return { vector: embedding }
        }
        const expectedShape = isGoogleNative
          ? "embedding.values"
          : isDoubaoMultimodal
            ? "data.embedding"
            : "data[0].embedding"
        const error = `Embedding response missing ${expectedShape} (got ${JSON.stringify(data).slice(0, 200)})`
        return { vector: null, error }
      }

      // Non-OK: try to read the body for an oversize hint.
      let bodyText = ""
      try {
        bodyText = await resp.text()
      } catch {
        // ignore — some servers return empty bodies on error
      }

      if (looksLikeOversizeError(resp.status, bodyText)) {
        // Can we still halve-and-retry? Need room on both axes:
        // text not yet at the 64-char floor, and retry budget left.
        if (current.length > 64 && attempts <= maxRetries) {
          const prev = current.length
          current = current.slice(0, Math.floor(current.length / 2))
          deps.onRetry?.(`auto-halving after HTTP ${resp.status} at ${prev} chars → retrying at ${current.length} chars (attempt ${attempts}/${maxRetries + 1})`);
          continue
        }
        // Out of retries on a SERVER-oversize error — give the user a
        // message that names the smallest size that still failed so
        // they can tune Settings → Embedding accordingly.
        const error = `Endpoint rejected input even at ${current.length} chars — server context smaller than expected. Lower Settings → Embedding → Max Chunk Chars (${bodyText.slice(0, 160)}).`
        return { vector: null, error }
      }

      // Non-oversize definitive failure (auth, rate limit, server down, …).
      const error = `API ${resp.status} ${resp.statusText}${bodyText ? ` — ${bodyText.slice(0, 200)}` : ""} at ${endpoint}`
      return { vector: null, error }
    } catch (err) {
      let error: string
      if (deps.isNetworkError?.(err)) {
        error = `Network error reaching ${endpoint}. Check endpoint URL, API key, and connectivity.`
      } else {
        error = err instanceof Error ? err.message : String(err)
      }
      return { vector: null, error }
    }
  }

  // Exhausted retries (only reachable if every halving round triggered
  // the retry branch and then the loop condition ended).
  const error = `Embedding endpoint rejected every size down to ${current.length} chars — the server's context is smaller than ${current.length * 2}. Lower Settings → Embedding → Max Chunk Chars.`
  return { vector: null, error }
}

// ---------------------------------------------------------------------------
// Batch variant — sends the whole texts[] in a single OpenAI-compatible call.
// For Google-native / Doubao configs that do not accept an array input, we
// fall back to calling fetchEmbedding once per text (correctness over speed).
// ---------------------------------------------------------------------------
export async function fetchEmbeddingBatch(
  texts: string[],
  cfg: EmbeddingConfig,
  deps: EmbeddingDeps,
  maxRetries = 3,
): Promise<EmbeddingBatchResult> {
  if (texts.length === 0) return { vectors: [] };
  if (!cfg.endpoint) return { vectors: texts.map(() => null) };

  const isGoogleNative = isGoogleEmbeddingConfig(cfg);
  const isDoubaoMultimodal = isDoubaoMultimodalEmbeddingConfig(cfg);

  // Providers that require a custom (non-array) body format: fall back to
  // one-at-a-time via the existing fetchEmbedding to stay correct.
  if (isGoogleNative || isDoubaoMultimodal) {
    const vectors: (number[] | null)[] = [];
    for (const text of texts) {
      const r = await fetchEmbedding(text, cfg, deps, maxRetries);
      vectors.push(r.vector);
    }
    return { vectors };
  }

  // OpenAI-compatible path: POST { model, input: string[] }
  const endpoint = volcengineEmbeddingEndpoint(cfg);

  // Build headers (same logic as fetchEmbedding, intentionally inlined to
  // avoid any risk of behavioural drift on the single-text path).
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(deps.originHeader && isLocalOrPrivateHttpEndpoint(endpoint) ? deps.originHeader() : {}),
  };
  if (cfg.apiKey) {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }
  if (cfg.extraHeaders) {
    for (const [k, v] of Object.entries(cfg.extraHeaders)) {
      const name = k.trim();
      const value = v.trim();
      if (!isSafeExtraHeader(name, value)) continue;
      headers[name] = value;
    }
  }

  const allNull = (): (number[] | null)[] => texts.map(() => null);
  const safeTexts = texts.map(toWellFormedText);

  try {
    const resp = await deps.fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.model, input: safeTexts }),
    });

    if (resp.ok) {
      const json = await resp.json() as any;
      const data = json?.data;
      if (!Array.isArray(data)) {
        return { vectors: allNull(), error: "batch embedding response missing data[]" };
      }
      const vectors: (number[] | null)[] = texts.map(() => null);
      for (const item of data) {
        if (typeof item?.index === "number" && isNonEmptyNumberArray(item.embedding)) {
          vectors[item.index] = item.embedding;
        }
      }
      return { vectors };
    }

    // Non-OK response
    let bodyText = "";
    try { bodyText = await resp.text(); } catch { /* ignore */ }

    // Oversize: split and recurse on halves when there is more than one text.
    if (looksLikeOversizeError(resp.status, bodyText) && texts.length > 1) {
      const mid = Math.floor(texts.length / 2);
      const [left, right] = await Promise.all([
        fetchEmbeddingBatch(texts.slice(0, mid), cfg, deps, maxRetries),
        fetchEmbeddingBatch(texts.slice(mid), cfg, deps, maxRetries),
      ]);
      return { vectors: [...left.vectors, ...right.vectors] };
    }

    return { vectors: allNull(), error: `API ${resp.status} ${resp.statusText}` };
  } catch (err) {
    const error = deps.isNetworkError?.(err)
      ? `Network error reaching ${endpoint}.`
      : err instanceof Error ? err.message : String(err);
    return { vectors: allNull(), error };
  }
}
