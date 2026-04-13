import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { CostAwareBedrock, createDynamoStores } from "../src/index.js";

const { pricingStore, policyStore, usageStore } = createDynamoStores({
  ddbClientConfig: { region: "us-east-1" },
  pricingTableName: "bedrock_pricing",
  policyTableName: "bedrock_budget_policies",
  usageAggregateTableName: "bedrock_usage_aggregates",
  usageEventTableName: "bedrock_usage_events",
});

const wrapped = new CostAwareBedrock(new BedrockRuntimeClient({ region: "us-east-1" }), {
  pricingStore,
  policyStore,
  usageStore,
});

async function run() {
  const res = await wrapped.converse(
    {
      modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
      messages: [{ role: "user", content: [{ text: "Summarize this architecture and provide 5 cost optimization ideas." }] }],
      inferenceConfig: { maxTokens: 120 },
    },
    {
      userId: "user-123",
      teamId: "team-alpha",
      appId: "assistant-api",
      feature: "haiku",
      priority: "normal",
    }
  );

  console.log(res.output?.message?.content);
}

void run();
