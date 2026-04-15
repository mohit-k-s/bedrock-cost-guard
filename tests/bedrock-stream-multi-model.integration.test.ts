import "./load-env.js";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import {
  CostAwareBedrock,
  InMemoryPolicyStore,
  InMemoryPricingStore,
  InMemoryUsageStore,
} from "../src/index.js";

type LiveModelConfig = {
  name: string;
  modelId: string;
  inputPer1kUsd: number;
  outputPer1kUsd: number;
};

const region = process.env.AWS_REGION ?? "us-east-1";
const liveModels = loadLiveModels();
const runIntegration = process.env.RUN_BEDROCK_INTEGRATION === "1";
const shouldRunIntegration = runIntegration && liveModels.length === 2;
const integrationDescribe = shouldRunIntegration ? describe : describe.skip;

integrationDescribe("CostAwareBedrock converseStream multi-model integration", () => {
  it(
    "runs a set of conversations against Nova and Claude Sonnet and logs in-memory store state",
    async () => {
      const pricingStore = new InMemoryPricingStore(
        liveModels.map((model) => ({
          modelId: model.modelId,
          inputPer1kUsd: model.inputPer1kUsd,
          outputPer1kUsd: model.outputPer1kUsd,
          currency: "USD" as const,
        }))
      );
      const policyStore = new InMemoryPolicyStore([
        {
          scope: "team",
          scopeId: "team-stream-live",
          perRequestLimitUsd: 10,
          dailyLimitUsd: 100,
          monthlyLimitUsd: 1000,
          allowedModelIds: liveModels.map((model) => model.modelId),
        },
        {
          scope: "user",
          scopeId: "user-stream-live",
          perRequestLimitUsd: 5,
          dailyLimitUsd: 25,
          monthlyLimitUsd: 200,
          allowedModelIds: liveModels.map((model) => model.modelId),
        },
      ]);
      const usageStore = new InMemoryUsageStore();
      const wrapped = new CostAwareBedrock(new BedrockRuntimeClient({ region }), {
        pricingStore,
        policyStore,
        usageStore,
      });

      const conversations = [
        "Reply with one short sentence describing what a budget guard does.",
        "List exactly three practical ways to reduce LLM cost in production.",
        "Return a two-line explanation of why streaming responses can improve UX.",
      ];

      const outputs: Array<{ model: string; prompt: string; text: string }> = [];

      for (const model of liveModels) {
        for (const prompt of conversations) {
          const response = await wrapped.converseStream(
            {
              modelId: model.modelId,
              messages: [
                {
                  role: "user",
                  content: [{ text: prompt }],
                },
              ],
              inferenceConfig: {
                maxTokens: 80,
              },
            },
            {
              userId: "user-stream-live",
              teamId: "team-stream-live",
              appId: "integration-test",
              feature: `converse-stream-${model.name}`,
              priority: "normal",
            }
          );

          const text = await collectStreamText(response.stream);
          outputs.push({ model: model.name, prompt, text });
        }
      }

      console.log(
        JSON.stringify(
          {
            outputs,
            pricingStore: pricingStore.getAll(),
            policyStore: policyStore.getAll(),
            usageEvents: usageStore.getEvents(),
            usageAggregates: usageStore.getAggregates(),
          },
          null,
          2
        )
      );

      expect(outputs).toHaveLength(liveModels.length * conversations.length);
      expect(outputs.every((item) => item.text.trim().length > 0)).toBe(true);
      expect(usageStore.getEvents()).toHaveLength(liveModels.length * conversations.length);
      expect(usageStore.getAggregates().length).toBeGreaterThan(0);
    },
    120_000
  );
});

async function collectStreamText(
  stream: AsyncIterable<{
    contentBlockDelta?: { delta?: { text?: string } };
  }> | undefined
): Promise<string> {
  if (!stream) return "";

  let text = "";
  for await (const chunk of stream) {
    text += chunk.contentBlockDelta?.delta?.text ?? "";
  }
  return text;
}

function loadLiveModels(): LiveModelConfig[] {
  const models = [
    loadModelConfig("nova", "BEDROCK_NOVA_MODEL_ID", "BEDROCK_NOVA_INPUT_PER_1K_USD", "BEDROCK_NOVA_OUTPUT_PER_1K_USD"),
    loadModelConfig(
      "claude-sonnet",
      "BEDROCK_CLAUDE_SONNET_MODEL_ID",
      "BEDROCK_CLAUDE_SONNET_INPUT_PER_1K_USD",
      "BEDROCK_CLAUDE_SONNET_OUTPUT_PER_1K_USD"
    ),
  ];

  return models.filter((model): model is LiveModelConfig => model !== undefined);
}

function loadModelConfig(
  name: string,
  modelEnv: string,
  inputEnv: string,
  outputEnv: string
): LiveModelConfig | undefined {
  const modelId = process.env[modelEnv];
  const inputPer1kUsd = numberFromEnv(inputEnv);
  const outputPer1kUsd = numberFromEnv(outputEnv);

  if (!modelId || inputPer1kUsd === undefined || outputPer1kUsd === undefined) {
    return undefined;
  }

  return {
    name,
    modelId,
    inputPer1kUsd,
    outputPer1kUsd,
  };
}

function numberFromEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
