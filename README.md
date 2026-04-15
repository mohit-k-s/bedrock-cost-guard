# bedrock-cost-guard

A fast TypeScript wrapper around AWS Bedrock Runtime SDK (v3) that adds cost-aware controls by user and team.

## What it does

- Enforces required request context (`userId`, `teamId`)
- Estimates pre-call cost from prompt size + `maxTokens`
- Applies per-user and per-team policy checks:
  - per-request limit
  - daily/monthly budget limits
  - model allowlist checks
  - optional fallback model when thresholds are hit
- Calls Bedrock `Converse` and `ConverseStream`
- Computes post-call actual cost from usage tokens
- Records usage for user/team aggregate accounting

## Install

```bash
npm install
npm run build
```

## Quick start (in-memory)

See `examples/example.ts` for a complete wiring sample.

```ts
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import {
  CostAwareBedrock,
  InMemoryPolicyStore,
  InMemoryPricingStore,
  InMemoryUsageStore,
} from "../src/index.js";

const client = new BedrockRuntimeClient({ region: "us-east-1" });
const pricingStore = new InMemoryPricingStore([...]);
const policyStore = new InMemoryPolicyStore([...]);
const usageStore = new InMemoryUsageStore();

const wrapped = new CostAwareBedrock(client, {
  policyStore,
  pricingStore,
  usageStore,
});
```

## Integration test against Bedrock

There is a live integration test that uses the in-memory stores and makes a real Bedrock `Converse` call.

Set these environment variables before running it:

```bash
export AWS_REGION=us-east-1
export RUN_BEDROCK_INTEGRATION=1
export BEDROCK_MODEL_ID=amazon.nova-lite-v1:0
export BEDROCK_INPUT_PER_1K_USD=0.00006
export BEDROCK_OUTPUT_PER_1K_USD=0.00024
npm run test:integration
```

The test is defined in `tests/bedrock.integration.test.ts`. It loads values from the repo `.env` file if present. It only runs when `RUN_BEDROCK_INTEGRATION=1`. If that flag is not set, or if `BEDROCK_MODEL_ID`, `BEDROCK_INPUT_PER_1K_USD`, or `BEDROCK_OUTPUT_PER_1K_USD` is missing, the test is skipped.

## Streaming integration test across Nova and Claude Sonnet

There is also a live `converseStream` integration test that runs a small set of prompts against both Nova and Claude Sonnet using the in-memory stores, then prints the in-memory pricing, policy, usage event, and aggregate state.

Set these environment variables before running it:

```bash
export AWS_REGION=us-east-1
export RUN_BEDROCK_INTEGRATION=1
export BEDROCK_NOVA_MODEL_ID=amazon.nova-lite-v1:0
export BEDROCK_NOVA_INPUT_PER_1K_USD=0.00006
export BEDROCK_NOVA_OUTPUT_PER_1K_USD=0.00024
export BEDROCK_CLAUDE_SONNET_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0
export BEDROCK_CLAUDE_SONNET_INPUT_PER_1K_USD=0.003
export BEDROCK_CLAUDE_SONNET_OUTPUT_PER_1K_USD=0.015
npm run test:integration:stream
```

The test is defined in `tests/bedrock-stream-multi-model.integration.test.ts`. It loads values from the repo `.env` file if present. It only runs when `RUN_BEDROCK_INTEGRATION=1`. If that flag is not set, or if either model config is incomplete, the test is skipped.

## DynamoDB-backed stores

See `examples/example-dynamodb.ts`.

```ts
import { createDynamoStores } from "../src/index.js";

const { pricingStore, policyStore, usageStore } = createDynamoStores({
  ddbClientConfig: { region: "us-east-1" },
  pricingTableName: "bedrock_pricing",
  policyTableName: "bedrock_budget_policies",
  usageAggregateTableName: "bedrock_usage_aggregates",
  usageEventTableName: "bedrock_usage_events",
});
```

### Table schemas

#### 1) `bedrock_pricing`
- **PK**: `modelId` (String)
- Attributes:
  - `inputPer1kUsd` (Number)
  - `outputPer1kUsd` (Number)
  - `effectiveFrom` (String, optional)

Example item:
```json
{
  "modelId": "amazon.nova-lite-v1:0",
  "inputPer1kUsd": 0.0006,
  "outputPer1kUsd": 0.0024,
  "effectiveFrom": "2026-04-01"
}
```

#### 2) `bedrock_budget_policies`
- **PK**: `pk` (String) where `pk` is one of:
  - `team#<teamId>`
  - `user#<userId>`
- **SK**: `policyId` (String) (lets you store multiple policies per scope)
- Attributes:
  - `perRequestLimitUsd` (Number, optional)
  - `dailyLimitUsd` (Number, optional)
  - `monthlyLimitUsd` (Number, optional)
  - `softThresholdPct` (Number, optional)
  - `allowedModelIds` (List<String>, optional)
  - `preferredFallbackModelId` (String, optional)

#### 3) `bedrock_usage_aggregates`
- **PK**: `pk` (String) in format:
  - `user#<id>#daily#YYYY-MM-DD`
  - `user#<id>#monthly#YYYY-MM`
  - `team#<id>#daily#YYYY-MM-DD`
  - `team#<id>#monthly#YYYY-MM`
- Attributes (updated atomically):
  - `scope`, `scopeId`, `window`, `windowKey`
  - `spentUsd` (Number)
  - `inputTokens` (Number)
  - `outputTokens` (Number)
  - `requestCount` (Number)
  - `updatedAt` (String)

#### 4) `bedrock_usage_events`
- **PK**: `pk` (String) = `request#<requestId>`
- Attributes:
  - request context (`userId`, `teamId`, `appId`, `feature`, `priority`)
  - model/cost (`modelId`, `estimatedUsd`, `actualUsd`)
  - tokens (`inputTokens`, `outputTokens`)
  - decision (`decisionAllow`, `decisionReason`, `decisionModelId`)
  - `timestamp`, `metadata`

## Behavior notes

- `recordUsage` writes an event and then atomically increments four aggregates:
  - user-daily, user-monthly, team-daily, team-monthly
- Policy checks read aggregates and compare against estimated pre-call cost.
- For strict no-overspend guarantees under extreme concurrency, add a reservation/commit model.

## Next steps for production

- Add process-local cache for pricing/policy reads (TTL)
- Add optional fail-open/fail-closed strategy when policy store is unavailable
- Emit usage events to stream (Kinesis/Kafka/SQS) for analytics and alerts
- Add reservation table if you need stronger concurrency guarantees for pre-call budget enforcement
