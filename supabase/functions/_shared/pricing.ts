export const USD_TO_PHP = 58.50

// claude-opus-4-8 list price, USD per token
const RATES = {
  input: 5 / 1_000_000,
  output: 25 / 1_000_000,
  cacheRead: 0.5 / 1_000_000,
  cacheWrite: 6.25 / 1_000_000,
}

export interface Usage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export function computeCost(u: Usage): { cost_usd: number; cost_php: number } {
  const usd =
    (u.input_tokens ?? 0) * RATES.input +
    (u.output_tokens ?? 0) * RATES.output +
    (u.cache_read_input_tokens ?? 0) * RATES.cacheRead +
    (u.cache_creation_input_tokens ?? 0) * RATES.cacheWrite
  return { cost_usd: usd, cost_php: usd * USD_TO_PHP }
}
