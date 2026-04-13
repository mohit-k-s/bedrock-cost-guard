import { describe, expect, it, vi } from "vitest";
import type {
  ConverseCommandOutput,
  ConverseStreamCommandOutput,
  ConverseStreamOutput,
} from "@aws-sdk/client-bedrock-runtime";
import {
  CostAwareBedrock,
  InMemoryPolicyStore,
  InMemoryPricingStore,
  InMemoryUsageStore,
} from "../src/index.js";

function createMockClient(response: ConverseCommandOutput | ConverseStreamCommandOutput) {
  return {
    send: vi.fn().mockResolvedValue(response),
  };
}

async function collectStream(stream: AsyncIterable<ConverseStreamOutput>): Promise<ConverseStreamOutput[]> {
  const out: ConverseStreamOutput[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe("CostAwareBedrock", () => {
  it("allows request and records usage", async () => {
    const mockResponse: ConverseCommandOutput = {
      usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
    };
    const client = createMockClient(mockResponse);

    const wrapper = new CostAwareBedrock(client as never, {
      pricingStore: new InMemoryPricingStore([
        {
          modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
          inputPer1kUsd: 0.003,
          outputPer1kUsd: 0.015,
          currency: "USD",
        },
      ]),
      policyStore: new InMemoryPolicyStore([
        {
          scope: "team",
          scopeId: "team-alpha",
          perRequestLimitUsd: 5,
          dailyLimitUsd: 100,
          monthlyLimitUsd: 1000,
        },
      ]),
      usageStore: new InMemoryUsageStore(),
    });

    await wrapper.converse(
      {
        modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        messages: [{ role: "user", content: [{ text: "hello" }] }],
        inferenceConfig: { maxTokens: 100 },
      },
      { userId: "user-1", teamId: "team-alpha" }
    );

    expect(client.send).toHaveBeenCalledOnce();
  });

  it("denies request when per-request limit is exceeded", async () => {
    const client = createMockClient({ usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });

    const wrapper = new CostAwareBedrock(client as never, {
      pricingStore: new InMemoryPricingStore([
        {
          modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
          inputPer1kUsd: 0.003,
          outputPer1kUsd: 0.015,
          currency: "USD",
        },
      ]),
      policyStore: new InMemoryPolicyStore([
        {
          scope: "team",
          scopeId: "team-alpha",
          perRequestLimitUsd: 0.00001,
        },
      ]),
      usageStore: new InMemoryUsageStore(),
    });

    await expect(
      wrapper.converse(
        {
          modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
          messages: [{ role: "user", content: [{ text: "hello" }] }],
          inferenceConfig: { maxTokens: 100 },
        },
        { userId: "user-1", teamId: "team-alpha" }
      )
    ).rejects.toThrow("BudgetPolicyDenied: per_request_limit");

    expect(client.send).not.toHaveBeenCalled();
  });

  it("switches to fallback model when limit exceeded and fallback is configured", async () => {
    const mockResponse: ConverseCommandOutput = {
      usage: { inputTokens: 90, outputTokens: 30, totalTokens: 120 },
    };
    const client = createMockClient(mockResponse);

    const wrapper = new CostAwareBedrock(client as never, {
      pricingStore: new InMemoryPricingStore([
        {
          modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
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
      ]),
      policyStore: new InMemoryPolicyStore([
        {
          scope: "team",
          scopeId: "team-alpha",
          perRequestLimitUsd: 0.00001,
          preferredFallbackModelId: "amazon.nova-lite-v1:0",
        },
      ]),
      usageStore: new InMemoryUsageStore(),
    });

    await wrapper.converse(
      {
        modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        messages: [{ role: "user", content: [{ text: "hello" }] }],
        inferenceConfig: { maxTokens: 100 },
      },
      { userId: "user-1", teamId: "team-alpha" }
    );

    const firstCallArg = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstCallArg.input.modelId).toBe("amazon.nova-lite-v1:0");
  });

  it("supports converseStream with policy checks and usage accounting", async () => {
    const streamResponse: ConverseStreamCommandOutput = {
      stream: (async function* () {
        yield {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { text: "hello" },
          },
        };
        yield {
          metadata: {
            metrics: { latencyMs: 12 },
            usage: { inputTokens: 200, outputTokens: 60, totalTokens: 260 },
          },
        };
      })(),
    };

    const usageStore = new InMemoryUsageStore();
    const client = createMockClient(streamResponse);
    const wrapper = new CostAwareBedrock(client as never, {
      pricingStore: new InMemoryPricingStore([
        {
          modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
          inputPer1kUsd: 0.003,
          outputPer1kUsd: 0.015,
          currency: "USD",
        },
      ]),
      policyStore: new InMemoryPolicyStore([
        {
          scope: "team",
          scopeId: "team-alpha",
          perRequestLimitUsd: 5,
        },
      ]),
      usageStore,
    });

    const response = await wrapper.converseStream(
      {
        modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        messages: [{ role: "user", content: [{ text: "stream hello" }] }],
        inferenceConfig: { maxTokens: 100 },
      },
      { userId: "user-1", teamId: "team-alpha" }
    );

    expect(response.stream).toBeDefined();
    await collectStream(response.stream!);

    const monthlyUser = await usageStore.getAggregate("user", "user-1", "monthly", new Date());
    expect(monthlyUser.inputTokens).toBe(200);
    expect(monthlyUser.outputTokens).toBe(60);
    expect(monthlyUser.spentUsd).toBeGreaterThan(0);
  });
});
