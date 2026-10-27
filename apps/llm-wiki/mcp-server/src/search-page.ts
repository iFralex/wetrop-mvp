import type { ApiSearchResponse } from "./api-client.js"

export const DEFAULT_SEARCH_PAGE_SIZE = 5
export const MAX_SEARCH_PAGE_SIZE = 10
export const MAX_SEARCH_RESULTS = 50

export interface WikiSearchPage {
  results: ApiSearchResponse["results"]
  mode?: string
  tokenHits?: number
  vectorHits?: number
  page: {
    offset: number
    returned: number
    hasMore: boolean
    nextOffset?: number
  }
}

function boundedInteger(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(0, Math.trunc(parsed)))
}

export function normalizeWikiSearchPage(topK?: number, offset?: number): {
  limit: number
  offset: number
  fetchTopK: number
} {
  const limit = Math.max(1, boundedInteger(topK, DEFAULT_SEARCH_PAGE_SIZE, MAX_SEARCH_PAGE_SIZE))
  const normalizedOffset = boundedInteger(offset, 0, MAX_SEARCH_RESULTS - 1)
  return {
    limit,
    offset: normalizedOffset,
    fetchTopK: Math.min(MAX_SEARCH_RESULTS, normalizedOffset + limit + 1),
  }
}

export function buildWikiSearchPage(
  search: ApiSearchResponse,
  limit: number,
  offset: number,
): WikiSearchPage {
  const results = search.results.slice(offset, offset + limit)
  const hasMore = search.results.length > offset + results.length
  return {
    results,
    ...(search.mode ? { mode: search.mode } : {}),
    ...(typeof search.tokenHits === "number" ? { tokenHits: search.tokenHits } : {}),
    ...(typeof search.vectorHits === "number" ? { vectorHits: search.vectorHits } : {}),
    page: {
      offset,
      returned: results.length,
      hasMore,
      ...(hasMore ? { nextOffset: offset + results.length } : {}),
    },
  }
}
