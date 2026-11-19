/**
 * Per-model pricing tables for budget normalization.
 *
 * Standard text token prices in USD per 1M, verified 2026-09-08.
 * https://ai.google.dev/gemini-api/docs/pricing
 * https://platform.claude.com/docs/en/about-claude/pricing
 */

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-opus-5.5': { inputPer1M: 4.00, outputPer1M: 20.00 },
  'gemini-3.1-pro-preview': { inputPer1M: 2.00, outputPer1M: 12.00 },
  'opus': { inputPer1M: 5.00, outputPer1M: 25.00 },
  'claude-opus-4-6': { inputPer1M: 5.00, outputPer1M: 25.00 },
  'sonnet': { inputPer1M: 2.00, outputPer1M: 10.00 },
  'claude-sonnet-4-6': { inputPer1M: 3.00, outputPer1M: 15.00 },
  'haiku': { inputPer1M: 1.00, outputPer1M: 5.00 },
  'claude-haiku-4-5': { inputPer1M: 1.00, outputPer1M: 5.00 },

  'claude-sonnet-5': { inputPer1M: 2.00, outputPer1M: 10.00 },
  'claude-fable-5-1': { inputPer1M: 10.00, outputPer1M: 50.00 },

  // Google
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10.00 },
  'gemini-2.5-flash': { inputPer1M: 0.30, outputPer1M: 2.50 },
  'gemini-3.5-flash-lite': { inputPer1M: 0.30, outputPer1M: 2.50 },
  'pro': { inputPer1M: 1.25, outputPer1M: 10.00 },
  'flash': { inputPer1M: 0.30, outputPer1M: 2.50 },

  // OpenAI
  'gpt-6-astra': { inputPer1M: 10.00, outputPer1M: 50.00 },
  'gpt-6-sol': { inputPer1M: 2.00, outputPer1M: 10.00 },
  'gpt-6-luna': { inputPer1M: 0.10, outputPer1M: 0.50 },
  'gpt-4.1': { inputPer1M: 2.00, outputPer1M: 8.00 },
  'o3': { inputPer1M: 10.00, outputPer1M: 40.00 },

  // Free / BYOK
  'byok': { inputPer1M: 0, outputPer1M: 0 },
  'free': { inputPer1M: 0, outputPer1M: 0 },
};

export function getModelPricing(model: string, at: Date = new Date()): ModelPricing {
  const key = model.toLowerCase();
  if (['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash'].includes(key)) {
    return at.getTime() < Date.UTC(2027, 0, 1)
      ? { inputPer1M: 0.75, outputPer1M: 3.75 }
      : { inputPer1M: 1.50, outputPer1M: 7.50 };
  }
  return PRICING[key] ?? { inputPer1M: 1.00, outputPer1M: 5.00 };
}

export function estimateCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = getModelPricing(model);
  return (inputTokens / 1_000_000) * pricing.inputPer1M +
         (outputTokens / 1_000_000) * pricing.outputPer1M;
}

export function vendorOf(model: string): string {
  const key = model.toLowerCase();
  if (key.startsWith('claude') || key === 'opus' || key === 'sonnet' || key === 'haiku') return 'anthropic';
  if (key.startsWith('gemini') || key === 'pro' || key === 'flash') return 'google';
  if (key.startsWith('gpt') || key.startsWith('o3')) return 'openai';
  if (key === 'byok' || key === 'free') return 'byok';
  return 'unknown';
}

export function getCheapestModel(executorId: string): string {
  switch (executorId) {
    case 'hermes': return 'byok';
    case 'gemini': return 'flash';
    case 'codex': return 'gpt-4.1';
    case 'claude-code': return 'haiku';
    default: return 'byok';
  }
}
