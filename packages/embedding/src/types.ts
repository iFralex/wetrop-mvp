export interface EmbeddingConfig {
  endpoint: string;
  apiKey?: string;
  model: string;
  outputDimensionality?: number;
  extraHeaders?: Record<string, string>;
}

export interface EmbeddingDeps {
  /** Injected fetch (Tauri plugin fetch in the wiki, Node global fetch in mail). */
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
  /** Optional local-LLM CORS origin header (wiki injects Tauri origin; mail omits). */
  originHeader?: () => Record<string, string>;
  /** Optional network-error classifier (wiki injects Tauri's; defaults to false). */
  isNetworkError?: (err: unknown) => boolean;
  /** Optional retry notifier (the wiki logs auto-halve retries; mail omits it). */
  onRetry?: (message: string) => void;
}

export interface EmbeddingResult {
  vector: number[] | null;
  /** Human-readable failure description, or undefined on success. Byte-identical to the wiki's strings. */
  error?: string;
}
