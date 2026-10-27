import type { EmbeddingConfig } from "@steward/embedding";
import { gatewayCredential, usageHeaders } from "@steward/protocol";

export function loadDocumentEmbedConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig | null {
  const endpoint = env.DOCUMENT_EMBED_ENDPOINT ?? env.MAIL_EMBED_ENDPOINT ?? "http://127.0.0.1:4000/v1/embeddings";
  if (!endpoint || endpoint === "off") return null;
  const cfg: EmbeddingConfig = {
    endpoint,
    model: env.DOCUMENT_EMBED_MODEL ?? env.MAIL_EMBED_MODEL ?? "local-embed",
    extraHeaders: usageHeaders("documents-mcp", "search-embed"),
  };
  const apiKey = gatewayCredential(endpoint, env.DOCUMENT_EMBED_API_KEY ?? env.MAIL_EMBED_API_KEY, env.GATEWAY_API_KEY, Number(env.GATEWAY_PORT ?? 4000));
  if (apiKey) cfg.apiKey = apiKey;
  const dim = Number(env.DOCUMENT_EMBED_DIM ?? env.MAIL_EMBED_DIM);
  if (Number.isFinite(dim) && dim > 0) cfg.outputDimensionality = dim;
  return cfg;
}
