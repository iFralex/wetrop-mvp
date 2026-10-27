/**
 * Pure provider helpers — verbatim copies from:
 *   apps/llm-wiki/src/lib/embedding.ts  (all embedding helpers)
 *   apps/llm-wiki/src/lib/llm-providers.ts  (isLocalOrPrivateHttpEndpoint)
 *
 * NO Tauri / Node-only / React imports. Only standard JS (URL, regex, etc.).
 */

import type { EmbeddingConfig } from "./types.ts";

export const RESERVED_EMBEDDING_HEADER_NAMES = new Set([
  "authorization",
  "content-type",
  "host",
  "content-length",
  "origin",
  "x-goog-api-key",
])
export const HTTP_HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export function isSafeExtraHeader(name: string, value: string): boolean {
  const trimmedName = name.trim()
  const trimmedValue = value.trim()
  return (
    trimmedName.length > 0 &&
    trimmedValue.length > 0 &&
    HTTP_HEADER_NAME_RE.test(trimmedName) &&
    !RESERVED_EMBEDDING_HEADER_NAMES.has(trimmedName.toLowerCase())
  )
}

/**
 * Heuristic: does this error response look like an "input too long /
 * exceeds model context / payload too large" rejection? True for all
 * the phrasings we've seen from OpenAI, LM Studio, llama.cpp,
 * Ollama, and Azure. Safer to over-match than under-match — a false
 * positive just means a retry at half size, which will still succeed
 * on a real auth/model-id error (it won't) or just log the same error.
 */
export function looksLikeOversizeError(httpStatus: number, body: string): boolean {
  if (httpStatus === 413) return true
  const lower = body.toLowerCase()
  return (
    lower.includes("too long") ||
    lower.includes("maximum context") ||
    lower.includes("max_tokens") ||
    lower.includes("max tokens") ||
    lower.includes("context length") ||
    lower.includes("token limit") ||
    lower.includes("exceeds") ||
    lower.includes("input length")
  )
}

export function isNonEmptyNumberArray(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === "number" && Number.isFinite(item))
}

export function isGoogleEmbeddingConfig(cfg: EmbeddingConfig): boolean {
  const endpoint = cfg.endpoint.toLowerCase()
  return endpoint.includes("generativelanguage.googleapis.com")
    || /:embedcontent(\?|$)/i.test(endpoint)
}

export function isVolcengineEmbeddingEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase()
    return host === "volces.com"
      || host.endsWith(".volces.com")
      || host.includes("volcengine")
  } catch {
    const authority = endpoint
      .trim()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      .split(/[/?#]/, 1)[0]
      .toLowerCase()
    return authority === "volces.com"
      || authority.endsWith(".volces.com")
      || authority.includes("volcengine")
  }
}

export function isDoubaoMultimodalEmbeddingConfig(cfg: EmbeddingConfig): boolean {
  return cfg.model.trim().toLowerCase().includes("doubao-embedding-vision")
}

export function volcengineEmbeddingEndpoint(cfg: EmbeddingConfig): string {
  const raw = cfg.endpoint.trim()
  if (!isVolcengineEmbeddingEndpoint(raw)) return raw
  const targetSuffix = isDoubaoMultimodalEmbeddingConfig(cfg)
    ? "/embeddings/multimodal"
    : "/embeddings"
  return appendEndpointPath(raw, targetSuffix)
}

export function appendEndpointPath(endpoint: string, targetSuffix: string): string {
  const suffix = targetSuffix.replace(/^\/+/, "")
  try {
    const url = new URL(endpoint)
    const path = url.pathname.replace(/\/+$/, "")
    const lowerPath = path.toLowerCase()
    const lowerSuffix = `/${suffix.toLowerCase()}`
    if (lowerPath.endsWith(lowerSuffix)) {
      url.pathname = path || "/"
      return url.toString()
    }
    if (lowerPath.endsWith("/embeddings/multimodal") && lowerSuffix === "/embeddings") {
      url.pathname = path.slice(0, -"/multimodal".length) || "/"
      return url.toString()
    }
    if (lowerPath.endsWith("/embeddings") && lowerSuffix === "/embeddings/multimodal") {
      url.pathname = `${path}/multimodal`
      return url.toString()
    }
    url.pathname = `${path}/${suffix}`.replace(/\/{2,}/g, "/")
    return url.toString()
  } catch {
    const [base, query = ""] = endpoint.split("?", 2)
    const trimmed = base.replace(/\/+$/, "")
    const lower = trimmed.toLowerCase()
    const lowerSuffix = `/${suffix.toLowerCase()}`
    const next = lower.endsWith(lowerSuffix)
      ? trimmed
      : lower.endsWith("/embeddings/multimodal") && lowerSuffix === "/embeddings"
        ? trimmed.slice(0, -"/multimodal".length)
      : lower.endsWith("/embeddings") && lowerSuffix === "/embeddings/multimodal"
        ? `${trimmed}/multimodal`
        : `${trimmed}/${suffix}`
    return query ? `${next}?${query}` : next
  }
}

export function googleEmbeddingEndpoint(cfg: EmbeddingConfig): string {
  const raw = stripGoogleApiKeyQuery(cfg.endpoint.trim()).replace(/\/+$/, "")
  if (/:batchEmbedContents(\?|$)/i.test(raw)) {
    return raw.replace(/:batchEmbedContents/i, ":embedContent")
  }
  if (/:embedContent(\?|$)/i.test(raw)) return raw

  const modelPath = googleModelPath(cfg.model)
  if (/\/models\/[^/?]+$/i.test(raw)) {
    return `${raw}:embedContent`
  }
  return `${raw}/models/${encodeURIComponent(modelPath.replace(/^models\//, ""))}:embedContent`
}

export function stripGoogleApiKeyQuery(endpoint: string): string {
  if (!endpoint.includes("?")) return endpoint
  try {
    const url = new URL(endpoint)
    url.searchParams.delete("key")
    return url.toString()
  } catch {
    return endpoint.replace(/([?&])key=[^&]*&?/i, (_, prefix: string) => prefix === "?" ? "?" : "&")
      .replace(/[?&]$/, "")
      .replace("?&", "?")
  }
}

export function googleModelPath(model: string): string {
  const trimmed = model.trim()
  if (trimmed.startsWith("models/")) return trimmed
  return `models/${trimmed}`
}

export function googleEmbeddingBody(
  model: string,
  text: string,
  outputDimensionality?: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: googleModelPath(model),
    content: {
      parts: [{ text }],
    },
  }
  if (typeof outputDimensionality === "number" && Number.isFinite(outputDimensionality) && outputDimensionality > 0) {
    body.output_dimensionality = Math.floor(outputDimensionality)
  }
  return body
}

export function doubaoMultimodalEmbeddingBody(model: string, text: string): Record<string, unknown> {
  return {
    model,
    encoding_format: "float",
    input: [{ type: "text", text }],
  }
}

// Copied verbatim from apps/llm-wiki/src/lib/llm-providers.ts
// Purity verified: uses only new URL() — no Tauri/store/app imports.
export function isLocalOrPrivateHttpEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    const host = url.hostname.toLowerCase()
    if (host === "localhost" || host.endsWith(".localhost")) return true
    if (host === "127.0.0.1" || host === "::1" || host === "[::1]") return true
    if (/^10\./.test(host)) return true
    if (/^192\.168\./.test(host)) return true
    const m = host.match(/^172\.(\d+)\./)
    if (m) {
      const second = Number(m[1])
      if (second >= 16 && second <= 31) return true
    }
    return false
  } catch {
    return false
  }
}
