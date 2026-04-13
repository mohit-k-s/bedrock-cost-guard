import type { Pricing, Usage } from "./types.js";

export function estimateInputTokensFromJsonString(bodyJson: string): number {
  if (!bodyJson) return 0;
  return Math.ceil(bodyJson.length / 4);
}

export function estimateCostUsd(args: {
  pricing: Pricing;
  estimatedInputTokens: number;
  maxOutputTokens: number;
}): number {
  const inputCost = (args.estimatedInputTokens / 1000) * args.pricing.inputPer1kUsd;
  const outputCost = (args.maxOutputTokens / 1000) * args.pricing.outputPer1kUsd;
  return roundUsd(inputCost + outputCost);
}

export function computeActualCostUsd(pricing: Pricing, usage: Usage): number {
  const inputCost = (usage.inputTokens / 1000) * pricing.inputPer1kUsd;
  const outputCost = (usage.outputTokens / 1000) * pricing.outputPer1kUsd;
  return roundUsd(inputCost + outputCost);
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
