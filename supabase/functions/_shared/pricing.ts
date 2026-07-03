export const USD_TO_PHP = 58.50

// USD per token, by model. Unknown models fall back to opus-4-8 rates (safe over-estimate).
const MODEL_RATES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-8': {
    input: 5 / 1_000_000,
    output: 25 / 1_000_000,
    cacheRead: 0.5 / 1_000_000,
    cacheWrite: 6.25 / 1_000_000,
  },
  'claude-sonnet-5': {
    input: 3 / 1_000_000,
    output: 15 / 1_000_000,
    cacheRead: 0.3 / 1_000_000,
    cacheWrite: 3.75 / 1_000_000,
  },
  'claude-haiku-4-5': {
    input: 1 / 1_000_000,
    output: 5 / 1_000_000,
    cacheRead: 0.1 / 1_000_000,
    cacheWrite: 1.25 / 1_000_000,
  },
}

const DEFAULT_RATES = MODEL_RATES['claude-opus-4-8']

export interface Usage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export function computeCost(u: Usage, model: string): { cost_usd: number; cost_php: number } {
  const rates = MODEL_RATES[model] ?? DEFAULT_RATES
  const usd =
    (u.input_tokens ?? 0) * rates.input +
    (u.output_tokens ?? 0) * rates.output +
    (u.cache_read_input_tokens ?? 0) * rates.cacheRead +
    (u.cache_creation_input_tokens ?? 0) * rates.cacheWrite
  return { cost_usd: usd, cost_php: usd * USD_TO_PHP }
}
