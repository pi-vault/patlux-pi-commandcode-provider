/**
 * Command Code provider for pi.
 * Connects pi to Command Code's API (https://api.commandcode.ai/alpha/generate).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const API_BASE = "https://api.commandcode.ai";

const MODELS = [
  // Premium (Anthropic)
  { id: "claude-opus-4-7", name: "Claude Opus 4.7 (CC)", reasoning: true, contextWindow: 200_000, maxTokens: 32_000 },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6 (CC)", reasoning: true, contextWindow: 200_000, maxTokens: 32_000 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (CC)", reasoning: true, contextWindow: 200_000, maxTokens: 16_384 },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (CC)", reasoning: true, contextWindow: 200_000, maxTokens: 8_192 },
  // Premium (OpenAI)
  { id: "gpt-5.5", name: "GPT-5.5 (CC)", reasoning: true, contextWindow: 256_000, maxTokens: 128_000 },
  { id: "gpt-5.4", name: "GPT-5.4 (CC)", reasoning: true, contextWindow: 256_000, maxTokens: 128_000 },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex (CC)", reasoning: true, contextWindow: 256_000, maxTokens: 128_000 },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini (CC)", reasoning: false, contextWindow: 256_000, maxTokens: 128_000 },
  // Open-source
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro (CC)", reasoning: true, contextWindow: 1_000_000, maxTokens: 384_000 },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (CC)", reasoning: true, contextWindow: 1_000_000, maxTokens: 384_000 },
  { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6 (CC)", reasoning: true, contextWindow: 262_144, maxTokens: 131_072 },
  { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5 (CC)", reasoning: true, contextWindow: 262_144, maxTokens: 131_072 },
  { id: "zai-org/GLM-5.1", name: "GLM-5.1 (CC)", reasoning: true, contextWindow: 200_000, maxTokens: 131_072 },
  { id: "zai-org/GLM-5", name: "GLM-5 (CC)", reasoning: true, contextWindow: 200_000, maxTokens: 131_072 },
  { id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax M2.7 (CC)", reasoning: true, contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: "MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5 (CC)", reasoning: true, contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: "Qwen/Qwen3.6-Max-Preview", name: "Qwen 3.6 Max (CC)", reasoning: true, contextWindow: 1_000_000, maxTokens: 131_072 },
  { id: "Qwen/Qwen3.6-Plus", name: "Qwen 3.6 Plus (CC)", reasoning: true, contextWindow: 1_000_000, maxTokens: 131_072 },
];

export default function (pi: ExtensionAPI) {
  pi.registerProvider("commandcode", {
    name: "Command Code",
    baseUrl: API_BASE,
    api: "commandcode-custom" as any,
    headers: {
      "x-command-code-version": "0.24.1",
      "x-cli-environment": "production",
    },
    models: MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
  });
}
