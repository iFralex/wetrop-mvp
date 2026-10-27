/**
 * Registers the LLM gateway as an OpenAI-compatible Pi provider and resolves
 * the chosen capability tier as a model. The gateway needs no real key; a
 * placeholder satisfies Pi's auth check. Costs feed Pi's native getSessionStats.
 */
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { streamSimple as openAICompletionsStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responsesStreamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import type { Model } from "@earendil-works/pi-ai";
import { usageHeaders } from "@steward/protocol";

export interface GatewayConfig {
  api?: "openai-completions" | "openai-responses";
  baseUrl: string;
  tier: string;
  apiKey: string;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow?: number;
  maxTokens?: number;
  usageService?: string;
  usageAction?: string;
}

export function registerGatewayModel(cfg: GatewayConfig): {
  modelRegistry: ModelRegistry;
  model: Model<any>;
  authStorage: AuthStorage;
} {
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider("gateway", {
    name: "LLM Gateway",
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    headers: usageHeaders(
      cfg.usageService ?? "host",
      cfg.usageAction ?? "agent-turn",
    ),
    api: cfg.api ?? "openai-completions",
    streamSimple: (cfg.api === "openai-responses"
      ? responsesStreamSimple
      : openAICompletionsStreamSimple) as any,
    models: [
      {
        id: cfg.tier,
        name: cfg.tier,
        reasoning: true,
        input: ["text"],
        cost: cfg.cost,
        contextWindow: cfg.contextWindow ?? 128000,
        maxTokens: cfg.maxTokens ?? 8192,
      },
    ],
  });
  const model = modelRegistry.find("gateway", cfg.tier);
  if (!model) throw new Error(`gateway model ${cfg.tier} not registered`);
  return { modelRegistry, model, authStorage };
}
