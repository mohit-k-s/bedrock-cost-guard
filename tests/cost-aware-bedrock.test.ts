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
          inputPer1kUsd: 0.0001,
          outputPer1kUsd: 0.0002,
          currency: "USD",
        },
      ]),
      policyStore: new InMemoryPolicyStore([
        {
          scope: "team",
          scopeId: "team-alpha",
          perRequestLimitUsd: 0.00003,
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

  it("denies fallback when another matching policy disallows the fallback model", async () => {
    const client = createMockClient({
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

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
        {
          scope: "user",
          scopeId: "user-1",
          allowedModelIds: ["anthropic.claude-3-5-sonnet-20240620-v1:0"],
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
    ).rejects.toThrow("BudgetPolicyDenied: model_not_allowed");

    expect(client.send).not.toHaveBeenCalled();
  });

  it("fails before invoking Bedrock when fallback pricing is missing", async () => {
    const client = createMockClient({
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

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
          preferredFallbackModelId: "amazon.nova-lite-v1:0",
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
    ).rejects.toThrow("No pricing found for model: amazon.nova-lite-v1:0");

    expect(client.send).not.toHaveBeenCalled();
  });

  it("re-evaluates budgets using fallback pricing before invoking Bedrock", async () => {
    const client = createMockClient({
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

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
          inputPer1kUsd: 0.0001,
          outputPer1kUsd: 0.0002,
          currency: "USD",
        },
      ]),
      policyStore: new InMemoryPolicyStore([
        {
          scope: "team",
          scopeId: "team-alpha",
          perRequestLimitUsd: 0.00005,
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

  it("denies when fallback remains over the per-request limit after re-evaluation", async () => {
    const client = createMockClient({
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

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

  it("surfaces end-of-life model errors clearly for converse", async () => {
    const client = {
      send: vi.fn().mockRejectedValue(
        Object.assign(new Error("This model version has reached the end of its life. Please refer to the AWS documentation for more details."), {
          name: "ResourceNotFoundException",
        })
      ),
    };

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
    ).rejects.toThrow(
      "BedrockModelUnavailable: model anthropic.claude-3-5-sonnet-20240620-v1:0 is no longer available in Bedrock because that model version reached end of life. Update the configured model ID."
    );
  });

  it("surfaces end-of-life model errors clearly for converseStream", async () => {
    const client = {
      send: vi.fn().mockRejectedValue(
        Object.assign(new Error("This model version has reached the end of its life. Please refer to the AWS documentation for more details."), {
          name: "ResourceNotFoundException",
        })
      ),
    };

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
      usageStore: new InMemoryUsageStore(),
    });

    await expect(
      wrapper.converseStream(
        {
          modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
          messages: [{ role: "user", content: [{ text: "hello" }] }],
          inferenceConfig: { maxTokens: 100 },
        },
        { userId: "user-1", teamId: "team-alpha" }
      )
    ).rejects.toThrow(
      "BedrockModelUnavailable: model anthropic.claude-3-5-sonnet-20240620-v1:0 is no longer available in Bedrock because that model version reached end of life. Update the configured model ID."
    );
  });

  it("attributes converseStream usage to request start period across rollover", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-01-31T23:59:59.900Z");
    vi.setSystemTime(start);

    try {
      const streamResponse: ConverseStreamCommandOutput = {
        stream: (async function* () {
          yield {
            metadata: {
              metrics: { latencyMs: 12 },
              usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
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
          messages: [{ role: "user", content: [{ text: "rollover" }] }],
          inferenceConfig: { maxTokens: 50 },
        },
        { userId: "user-1", teamId: "team-alpha" }
      );

      vi.setSystemTime(new Date("2026-02-01T00:00:02.000Z"));
      await collectStream(response.stream!);

      const janMonthly = await usageStore.getAggregate("user", "user-1", "monthly", start);
      const febMonthly = await usageStore.getAggregate("user", "user-1", "monthly", new Date("2026-02-01T00:00:02.000Z"));

      expect(janMonthly.inputTokens).toBe(50);
      expect(janMonthly.outputTokens).toBe(20);
      expect(febMonthly.inputTokens).toBe(0);
      expect(febMonthly.outputTokens).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets daily budget enforcement on the next UTC day", async () => {
    vi.useFakeTimers();
    const client = createMockClient({
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    const usageStore = new InMemoryUsageStore();
    const wrapper = new CostAwareBedrock(client as never, {
      pricingStore: new InMemoryPricingStore([
        {
          modelId: "amazon.nova-lite-v1:0",
          inputPer1kUsd: 0.001,
          outputPer1kUsd: 0.001,
          currency: "USD",
        },
      ]),
      policyStore: new InMemoryPolicyStore([
        {
          scope: "team",
          scopeId: "team-alpha",
          dailyLimitUsd: 0.00002,
        },
      ]),
      usageStore,
    });

    try {
      vi.setSystemTime(new Date("2026-04-15T10:00:00.000Z"));

      await wrapper.converse(
        {
          modelId: "amazon.nova-lite-v1:0",
          messages: [{ role: "user", content: [{ text: "hello" }] }],
          inferenceConfig: { maxTokens: 1 },
        },
        { userId: "user-1", teamId: "team-alpha" }
      );

      await expect(
        wrapper.converse(
          {
            modelId: "amazon.nova-lite-v1:0",
            messages: [{ role: "user", content: [{ text: "hello again" }] }],
            inferenceConfig: { maxTokens: 1 },
          },
          { userId: "user-1", teamId: "team-alpha" }
        )
      ).rejects.toThrow("BudgetPolicyDenied: daily_limit");

      vi.setSystemTime(new Date("2026-04-16T00:00:01.000Z"));

      await expect(
        wrapper.converse(
          {
            modelId: "amazon.nova-lite-v1:0",
            messages: [{ role: "user", content: [{ text: "new day" }] }],
            inferenceConfig: { maxTokens: 1 },
          },
          { userId: "user-1", teamId: "team-alpha" }
        )
      ).resolves.toBeDefined();

      const april15 = await usageStore.getAggregate("team", "team-alpha", "daily", new Date("2026-04-15T12:00:00.000Z"));
      const april16 = await usageStore.getAggregate("team", "team-alpha", "daily", new Date("2026-04-16T12:00:00.000Z"));

      expect(april15.spentUsd).toBe(0.000015);
      expect(april16.spentUsd).toBe(0.000015);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets monthly budget enforcement on the next UTC month", async () => {
    vi.useFakeTimers();
    const client = createMockClient({
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    const usageStore = new InMemoryUsageStore();
    const wrapper = new CostAwareBedrock(client as never, {
      pricingStore: new InMemoryPricingStore([
        {
          modelId: "amazon.nova-lite-v1:0",
          inputPer1kUsd: 0.001,
          outputPer1kUsd: 0.001,
          currency: "USD",
        },
      ]),
      policyStore: new InMemoryPolicyStore([
        {
          scope: "team",
          scopeId: "team-alpha",
          monthlyLimitUsd: 0.00002,
        },
      ]),
      usageStore,
    });

    try {
      vi.setSystemTime(new Date("2026-04-30T10:00:00.000Z"));

      await wrapper.converse(
        {
          modelId: "amazon.nova-lite-v1:0",
          messages: [{ role: "user", content: [{ text: "hello" }] }],
          inferenceConfig: { maxTokens: 1 },
        },
        { userId: "user-1", teamId: "team-alpha" }
      );

      await expect(
        wrapper.converse(
          {
            modelId: "amazon.nova-lite-v1:0",
            messages: [{ role: "user", content: [{ text: "hello again" }] }],
            inferenceConfig: { maxTokens: 1 },
          },
          { userId: "user-1", teamId: "team-alpha" }
        )
      ).rejects.toThrow("BudgetPolicyDenied: monthly_limit");

      vi.setSystemTime(new Date("2026-05-01T00:00:01.000Z"));

      await expect(
        wrapper.converse(
          {
            modelId: "amazon.nova-lite-v1:0",
            messages: [{ role: "user", content: [{ text: "new month" }] }],
            inferenceConfig: { maxTokens: 1 },
          },
          { userId: "user-1", teamId: "team-alpha" }
        )
      ).resolves.toBeDefined();

      const april = await usageStore.getAggregate("team", "team-alpha", "monthly", new Date("2026-04-30T12:00:00.000Z"));
      const may = await usageStore.getAggregate("team", "team-alpha", "monthly", new Date("2026-05-01T12:00:00.000Z"));

      expect(april.spentUsd).toBe(0.000015);
      expect(may.spentUsd).toBe(0.000015);
    } finally {
      vi.useRealTimers();
    }
  });

});
