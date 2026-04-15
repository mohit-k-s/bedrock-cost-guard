import "./load-env.js";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import {
  CostAwareBedrock,
  InMemoryPolicyStore,
  InMemoryPricingStore,
  InMemoryUsageStore,
} from "../src/index.js";

const region = process.env.AWS_REGION ?? "us-east-1";
const modelId = process.env.BEDROCK_NOVA_MODEL_ID;
const inputPer1kUsd = numberFromEnv("BEDROCK_NOVA_INPUT_PER_1K_USD");
const outputPer1kUsd = numberFromEnv("BEDROCK_NOVA_OUTPUT_PER_1K_USD");
const runIntegration = process.env.RUN_BEDROCK_INTEGRATION === "1";

const shouldRunIntegration =
  runIntegration && Boolean(modelId) && inputPer1kUsd !== undefined && outputPer1kUsd !== undefined;

const integrationDescribe = shouldRunIntegration ? describe : describe.skip;

integrationDescribe("CostAwareBedrock integration", () => {
  it(
    "invokes Bedrock using in-memory stores and records usage",
    async () => {
      const usageStore = new InMemoryUsageStore();
      const wrapped = new CostAwareBedrock(new BedrockRuntimeClient({ region }), {
        pricingStore: new InMemoryPricingStore([
          {
            modelId: modelId!,
            inputPer1kUsd: inputPer1kUsd!,
            outputPer1kUsd: outputPer1kUsd!,
            currency: "USD",
          },
        ]),
        policyStore: new InMemoryPolicyStore([
          {
            scope: "team",
            scopeId: "team-integration",
            perRequestLimitUsd: 10,
            dailyLimitUsd: 100,
            monthlyLimitUsd: 1000,
          },
        ]),
        usageStore,
      });

      const response = await wrapped.converse(
        {
          modelId: modelId!,
          messages: [
            {
              role: "user",
              content: [{ text: "Reply with exactly the word OK." }],
            },
          ],
          inferenceConfig: {
            maxTokens: 20,
          },
        },
        {
          userId: "user-integration",
          teamId: "team-integration",
          appId: "integration-test",
          feature: "bedrock-live-call",
          priority: "normal",
        }
      );

      expect(response.output?.message?.content).toBeDefined();

      const monthlyUser = await usageStore.getAggregate(
        "user",
        "user-integration",
        "monthly",
        new Date()
      );
      const monthlyTeam = await usageStore.getAggregate(
        "team",
        "team-integration",
        "monthly",
        new Date()
      );

      expect(monthlyUser.spentUsd).toBeGreaterThan(0);
      expect(monthlyUser.inputTokens).toBeGreaterThan(0);
      expect(monthlyTeam.spentUsd).toBe(monthlyUser.spentUsd);
      expect(monthlyTeam.inputTokens).toBe(monthlyUser.inputTokens);
    },
    30_000
  );
});

function numberFromEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
