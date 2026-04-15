import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import {
  CostAwareBedrock,
  InMemoryPolicyStore,
  InMemoryPricingStore,
  InMemoryUsageStore,
} from "../src/index.js";

const pricingStore = new InMemoryPricingStore([
  {
    modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    inputPer1kUsd: 0.003,
    outputPer1kUsd: 0.015,
    currency: "USD",
  },
  {
    modelId: "amazon.nova-lite-v1:0",
    inputPer1kUsd: 0.0006,
    outputPer1kUsd: 0.0024,
    currency: "USD",
  },
]);

const policyStore = new InMemoryPolicyStore([
  {
    scope: "team",
    scopeId: "team-alpha",
    dailyLimitUsd: 20,
    monthlyLimitUsd: 500,
    perRequestLimitUsd: 0.5,
    softThresholdPct: 80,
    preferredFallbackModelId: "amazon.nova-lite-v1:0",
  },
  {
    scope: "user",
    scopeId: "user-123",
    dailyLimitUsd: 3,
    monthlyLimitUsd: 50,
    perRequestLimitUsd: 0.2,
  },
]);

const usageStore = new InMemoryUsageStore();

const client = new BedrockRuntimeClient({ region: "us-east-1" });

const wrapped = new CostAwareBedrock(client, {
  policyStore,
  pricingStore,
  usageStore,
});

async function run() {
  const response = await wrapped.converse(
    {
      modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      messages: [
        {
          role: "user",
          content: [{ text: "Summarize the key points of this RFC in 5 bullets." }],
        },
      ],
      inferenceConfig: {
        maxTokens: 300,
      },
    },
    {
      userId: "user-123",
      teamId: "team-alpha",
      appId: "assistant-api",
      feature: "summarization",
      priority: "normal",
    }
  );

  console.log(response.output?.message?.content);
}

void run();
