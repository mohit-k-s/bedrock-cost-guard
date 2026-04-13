import { describe, expect, it, vi } from "vitest";
import type { ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import {
  CostAwareBedrock,
  InMemoryPolicyStore,
  InMemoryPricingStore,
  InMemoryUsageStore,
} from "../src/index.js";

function createMockClient(response: ConverseCommandOutput) {
  return {
    send: vi.fn().mockResolvedValue(response),
  };
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
});
