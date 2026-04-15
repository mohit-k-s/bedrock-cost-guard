import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ConverseStreamCommandInput,
  type ConverseStreamCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { randomUUID } from "node:crypto";
import { computeActualCostUsd, estimateCostUsd, estimateInputTokensFromJsonString } from "./cost.js";
import { PolicyEngine } from "./policy-engine.js";
import type {
  BudgetDecision,
  InvokeContext,
  PolicyStore,
  PricingStore,
  Usage,
  UsageExtractor,
  UsageStore,
} from "./types.js";

type ConverseStreamEvent = NonNullable<ConverseStreamCommandOutput["stream"]> extends AsyncIterable<infer T>
  ? T
  : never;

export interface StreamUsageExtractor {
  extract(event: ConverseStreamEvent): Usage | undefined;
}

export type CostAwareBedrockOptions = {
  policyStore: PolicyStore;
  pricingStore: PricingStore;
  usageStore: UsageStore;
  usageExtractor?: UsageExtractor<ConverseCommandOutput>;
  streamUsageExtractor?: StreamUsageExtractor;
};

export class CostAwareBedrock {
  private readonly policyEngine: PolicyEngine;
  private readonly usageExtractor: UsageExtractor<ConverseCommandOutput>;
  private readonly streamUsageExtractor: StreamUsageExtractor;

  constructor(private readonly client: BedrockRuntimeClient, private readonly options: CostAwareBedrockOptions) {
    this.policyEngine = new PolicyEngine(options.policyStore, options.usageStore);
    this.usageExtractor = options.usageExtractor ?? new ConverseUsageExtractor();
    this.streamUsageExtractor = options.streamUsageExtractor ?? new ConverseStreamMetadataUsageExtractor();
  }

  async converse(input: ConverseCommandInput, context: InvokeContext): Promise<ConverseCommandOutput> {
    this.assertContext(context);
    const requestStartedAt = new Date();

    const modelId = input.modelId;
    if (!modelId) throw new Error("modelId is required");

    const prepared = await this.prepareInvocation({
      modelId,
      messages: input.messages,
      maxOutputTokens: input.inferenceConfig?.maxTokens ?? 0,
      context,
      requestStartedAt,
    });

    const resolvedInput: ConverseCommandInput =
      prepared.resolvedModelId === modelId ? input : { ...input, modelId: prepared.resolvedModelId };

    const response = await this.sendConverse(resolvedInput);
    const usage = this.usageExtractor.extract(response);

    await this.recordUsage({
      context,
      modelId: prepared.resolvedModelId,
      estimatedUsd: prepared.estimatedUsd,
      usage,
      decision: prepared.decision,
      requestStartedAt,
    });

    return response;
  }

  async converseStream(input: ConverseStreamCommandInput, context: InvokeContext): Promise<ConverseStreamCommandOutput> {
    this.assertContext(context);
    const requestStartedAt = new Date();

    const modelId = input.modelId;
    if (!modelId) throw new Error("modelId is required");

    const prepared = await this.prepareInvocation({
      modelId,
      messages: input.messages,
      maxOutputTokens: input.inferenceConfig?.maxTokens ?? 0,
      context,
      requestStartedAt,
    });

    const resolvedInput: ConverseStreamCommandInput =
      prepared.resolvedModelId === modelId ? input : { ...input, modelId: prepared.resolvedModelId };

    const response = await this.sendConverseStream(resolvedInput);

    if (!response.stream) {
      await this.recordUsage({
        context,
        modelId: prepared.resolvedModelId,
        estimatedUsd: prepared.estimatedUsd,
        usage: { inputTokens: 0, outputTokens: 0 },
        decision: prepared.decision,
        requestStartedAt,
      });
      return response;
    }

    const requestId = randomUUID();
    const sourceStream = response.stream;
    const usageStore = this.options.usageStore;
    const pricingStore = this.options.pricingStore;
    const streamUsageExtractor = this.streamUsageExtractor;

    const wrappedStream = (async function* () {
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };

      try {
        for await (const event of sourceStream) {
          const extracted = streamUsageExtractor.extract(event);
          if (extracted) usage = extracted;
          yield event;
        }
      } finally {
        const pricing = await pricingStore.get(prepared.resolvedModelId);
        if (!pricing) throw new Error(`No pricing found for model: ${prepared.resolvedModelId}`);
        const actualUsd = computeActualCostUsd(pricing, usage);

        await usageStore.recordUsage({
          requestId,
          context,
          modelId: prepared.resolvedModelId,
          estimatedUsd: prepared.estimatedUsd,
          actualUsd,
          usage,
          decision: prepared.decision,
          timestamp: requestStartedAt.toISOString(),
        });
      }
    })();

    return {
      ...response,
      stream: wrappedStream,
    };
  }

  private async prepareInvocation(args: {
    modelId: string;
    messages: unknown;
    maxOutputTokens: number;
    context: InvokeContext;
    requestStartedAt: Date;
  }): Promise<{ resolvedModelId: string; estimatedUsd: number; decision: BudgetDecision }> {
    const estimatedInputTokens = estimateInputTokensFromJsonString(JSON.stringify(args.messages ?? []));
    const seenModelIds = new Set<string>();
    let currentModelId = args.modelId;
    let finalDecision: BudgetDecision = { allow: true, reason: "allow" };
    let estimatedUsd = 0;

    while (true) {
      if (seenModelIds.has(currentModelId)) {
        throw new Error(`BudgetPolicyDenied: conflicting_fallback_models`);
      }
      seenModelIds.add(currentModelId);

      const pricing = await this.options.pricingStore.get(currentModelId);
      if (!pricing) throw new Error(`No pricing found for model: ${currentModelId}`);

      estimatedUsd = estimateCostUsd({
        pricing,
        estimatedInputTokens,
        maxOutputTokens: args.maxOutputTokens,
      });

      const decision = await this.policyEngine.evaluate({
        context: args.context,
        modelId: currentModelId,
        estimatedUsd,
        now: args.requestStartedAt,
      });

      if (!decision.allow) {
        throw new Error(`BudgetPolicyDenied: ${decision.reason}`);
      }

      finalDecision =
        currentModelId === args.modelId && !decision.modelId
          ? decision
          : { allow: true, reason: "fallback_model", modelId: currentModelId };

      if (!decision.modelId || decision.modelId === currentModelId) {
        return {
          resolvedModelId: currentModelId,
          estimatedUsd,
          decision: finalDecision,
        };
      }

      currentModelId = decision.modelId;
    }
  }

  private async recordUsage(args: {
    context: InvokeContext;
    modelId: string;
    estimatedUsd: number;
    usage: Usage;
    decision: BudgetDecision;
    requestStartedAt: Date;
  }): Promise<void> {
    const pricing = await this.options.pricingStore.get(args.modelId);
    if (!pricing) throw new Error(`No pricing found for model: ${args.modelId}`);
    const actualUsd = computeActualCostUsd(pricing, args.usage);

    await this.options.usageStore.recordUsage({
      requestId: randomUUID(),
      context: args.context,
      modelId: args.modelId,
      estimatedUsd: args.estimatedUsd,
      actualUsd,
      usage: args.usage,
      decision: args.decision,
      timestamp: args.requestStartedAt.toISOString(),
    });
  }

  private assertContext(context: InvokeContext): void {
    if (!context.userId || !context.teamId) {
      throw new Error("Missing required context: userId and teamId");
    }
  }

  private async sendConverse(input: ConverseCommandInput): Promise<ConverseCommandOutput> {
    try {
      return await this.client.send(new ConverseCommand(input));
    } catch (error) {
      throw normalizeBedrockInvokeError(error, input.modelId);
    }
  }

  private async sendConverseStream(input: ConverseStreamCommandInput): Promise<ConverseStreamCommandOutput> {
    try {
      return await this.client.send(new ConverseStreamCommand(input));
    } catch (error) {
      throw normalizeBedrockInvokeError(error, input.modelId);
    }
  }
}

function normalizeBedrockInvokeError(error: unknown, modelId: string | undefined): Error {
  const err = error as { name?: string; message?: string };

  if (err?.name === "ResourceNotFoundException") {
    const message = err.message ?? "";
    if (message.includes("model version has reached the end of its life")) {
      return new Error(
        `BedrockModelUnavailable: model ${modelId ?? "<unknown>"} is no longer available in Bedrock because that model version reached end of life. Update the configured model ID.`,
        { cause: error }
      );
    }

    return new Error(
      `BedrockModelUnavailable: model ${modelId ?? "<unknown>"} was not found or is not available in this account or region.`,
      { cause: error }
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

export class ConverseUsageExtractor implements UsageExtractor<ConverseCommandOutput> {
  extract(response: ConverseCommandOutput) {
    return {
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    };
  }
}

export class ConverseStreamMetadataUsageExtractor implements StreamUsageExtractor {
  extract(event: ConverseStreamEvent): Usage | undefined {
    const metadata = (event as { metadata?: { usage?: { inputTokens?: number; outputTokens?: number } } }).metadata;
    if (!metadata?.usage) return undefined;

    return {
      inputTokens: metadata.usage.inputTokens ?? 0,
      outputTokens: metadata.usage.outputTokens ?? 0,
    };
  }
}
