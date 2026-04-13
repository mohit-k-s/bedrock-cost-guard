import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { randomUUID } from "node:crypto";
import { computeActualCostUsd, estimateCostUsd, estimateInputTokensFromJsonString } from "./cost.js";
import { PolicyEngine } from "./policy-engine.js";
import type { InvokeContext, PolicyStore, PricingStore, UsageExtractor, UsageStore } from "./types.js";

export type CostAwareBedrockOptions = {
  policyStore: PolicyStore;
  pricingStore: PricingStore;
  usageStore: UsageStore;
  usageExtractor?: UsageExtractor<ConverseCommandOutput>;
};

export class CostAwareBedrock {
  private readonly policyEngine: PolicyEngine;
  private readonly usageExtractor: UsageExtractor<ConverseCommandOutput>;

  constructor(private readonly client: BedrockRuntimeClient, private readonly options: CostAwareBedrockOptions) {
    this.policyEngine = new PolicyEngine(options.policyStore, options.usageStore);
    this.usageExtractor = options.usageExtractor ?? new ConverseUsageExtractor();
  }

  async converse(input: ConverseCommandInput, context: InvokeContext): Promise<ConverseCommandOutput> {
    this.assertContext(context);

    const modelId = input.modelId;
    if (!modelId) throw new Error("modelId is required");

    const pricing = await this.options.pricingStore.get(modelId);
    if (!pricing) throw new Error(`No pricing found for model: ${modelId}`);

    const estimatedInputTokens = estimateInputTokensFromJsonString(JSON.stringify(input.messages ?? []));
    const maxOutputTokens = input.inferenceConfig?.maxTokens ?? 0;
    const estimatedUsd = estimateCostUsd({ pricing, estimatedInputTokens, maxOutputTokens });

    const decision = await this.policyEngine.evaluate({
      context,
      modelId,
      estimatedUsd,
      now: new Date(),
    });

    if (!decision.allow) {
      throw new Error(`BudgetPolicyDenied: ${decision.reason}`);
    }

    const resolvedModelId = decision.modelId ?? modelId;
    const resolvedInput: ConverseCommandInput =
      resolvedModelId === modelId ? input : { ...input, modelId: resolvedModelId };

    const response = await this.client.send(new ConverseCommand(resolvedInput));
    const usage = this.usageExtractor.extract(response);
    const actualPricing = await this.options.pricingStore.get(resolvedModelId);
    if (!actualPricing) throw new Error(`No pricing found for model: ${resolvedModelId}`);

    const actualUsd = computeActualCostUsd(actualPricing, usage);

    await this.options.usageStore.recordUsage({
      requestId: randomUUID(),
      context,
      modelId: resolvedModelId,
      estimatedUsd,
      actualUsd,
      usage,
      decision,
      timestamp: new Date().toISOString(),
    });

    return response;
  }

  private assertContext(context: InvokeContext): void {
    if (!context.userId || !context.teamId) {
      throw new Error("Missing required context: userId and teamId");
    }
  }
}

export class ConverseUsageExtractor implements UsageExtractor<ConverseCommandOutput> {
  extract(response: ConverseCommandOutput) {
    return {
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    };
  }
}
