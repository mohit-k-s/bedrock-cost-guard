# AWS Setup for `cost-aware-bedrock` (DynamoDB-backed)

This document sets up the AWS resources required by:

- `DynamoPricingStore`
- `DynamoPolicyStore`
- `DynamoUsageStore`

from `src/stores/dynamodb.ts`.

## 1) Prerequisites

- AWS CLI v2 installed and configured
- Permissions to create DynamoDB tables + IAM policy/role changes
- Region chosen (examples use `us-east-1`)

Set your environment:

```bash
export AWS_REGION=us-east-1
export AWS_PROFILE=default
```

---

## 2) Create DynamoDB tables

The library expects these table names by default in examples:

- `bedrock_pricing`
- `bedrock_budget_policies`
- `bedrock_usage_aggregates`
- `bedrock_usage_events`

All examples below use **PAY_PER_REQUEST** billing mode.

### 2.1 `bedrock_pricing`

Primary key: `modelId` (S)

```bash
aws dynamodb create-table \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" \
  --table-name bedrock_pricing \
  --attribute-definitions AttributeName=modelId,AttributeType=S \
  --key-schema AttributeName=modelId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

### 2.2 `bedrock_budget_policies`

Primary key: `pk` (S), sort key: `policyId` (S)

- `pk` format for scope:
  - `team#<teamId>`
  - `user#<userId>`

```bash
aws dynamodb create-table \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" \
  --table-name bedrock_budget_policies \
  --attribute-definitions \
    AttributeName=pk,AttributeType=S \
    AttributeName=policyId,AttributeType=S \
  --key-schema \
    AttributeName=pk,KeyType=HASH \
    AttributeName=policyId,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

### 2.3 `bedrock_usage_aggregates`

Primary key: `pk` (S)

- `pk` format:
  - `user#<id>#daily#YYYY-MM-DD`
  - `user#<id>#monthly#YYYY-MM`
  - `team#<id>#daily#YYYY-MM-DD`
  - `team#<id>#monthly#YYYY-MM`

```bash
aws dynamodb create-table \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" \
  --table-name bedrock_usage_aggregates \
  --attribute-definitions AttributeName=pk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

### 2.4 `bedrock_usage_events`

Primary key: `pk` (S)

- `pk` format: `request#<requestId>`

```bash
aws dynamodb create-table \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" \
  --table-name bedrock_usage_events \
  --attribute-definitions AttributeName=pk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

Wait until all tables are active:

```bash
for t in bedrock_pricing bedrock_budget_policies bedrock_usage_aggregates bedrock_usage_events; do
  aws dynamodb wait table-exists --region "$AWS_REGION" --profile "$AWS_PROFILE" --table-name "$t"
done
```

---

## 3) Seed minimal pricing and policies

### 3.1 Seed pricing

```bash
aws dynamodb put-item \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" \
  --table-name bedrock_pricing \
  --item '{
    "modelId": {"S": "amazon.nova-lite-v1:0"},
    "inputPer1kUsd": {"N": "0.0006"},
    "outputPer1kUsd": {"N": "0.0024"},
    "effectiveFrom": {"S": "2026-04-01"}
  }'
```

```bash
aws dynamodb put-item \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" \
  --table-name bedrock_pricing \
  --item '{
    "modelId": {"S": "anthropic.claude-3-5-sonnet-20240620-v1:0"},
    "inputPer1kUsd": {"N": "0.003"},
    "outputPer1kUsd": {"N": "0.015"},
    "effectiveFrom": {"S": "2026-04-01"}
  }'
```

### 3.2 Seed team policy (Claude Sonnet + fallback)

This policy allows Claude Sonnet for primary quality and configures fallback to Nova Lite when thresholds are hit.

```bash
aws dynamodb put-item \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" \
  --table-name bedrock_budget_policies \
  --item '{
    "pk": {"S": "team#team-alpha"},
    "policyId": {"S": "default"},
    "perRequestLimitUsd": {"N": "0.5"},
    "dailyLimitUsd": {"N": "20"},
    "monthlyLimitUsd": {"N": "500"},
    "softThresholdPct": {"N": "80"},
    "allowedModelIds": {"L": [
      {"S": "anthropic.claude-3-5-sonnet-20240620-v1:0"},
      {"S": "amazon.nova-lite-v1:0"}
    ]},
    "preferredFallbackModelId": {"S": "amazon.nova-lite-v1:0"}
  }'
```

### 3.3 Seed user policy

Optionally constrain user-level model choices too:

```bash
aws dynamodb put-item \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" \
  --table-name bedrock_budget_policies \
  --item '{
    "pk": {"S": "user#user-123"},
    "policyId": {"S": "model-guardrails"},
    "allowedModelIds": {"L": [
      {"S": "anthropic.claude-3-5-sonnet-20240620-v1:0"},
      {"S": "amazon.nova-lite-v1:0"}
    ]}
  }'
```

### 3.4 Seed user budget policy

```bash
aws dynamodb put-item \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" \
  --table-name bedrock_budget_policies \
  --item '{
    "pk": {"S": "user#user-123"},
    "policyId": {"S": "default"},
    "perRequestLimitUsd": {"N": "0.2"},
    "dailyLimitUsd": {"N": "3"},
    "monthlyLimitUsd": {"N": "50"}
  }'
```

---

## 4) IAM policy (least privilege starter)

Attach this policy to the runtime role/user used by your app.
Replace `<ACCOUNT_ID>` as needed.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockInvoke",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": "*"
    },
    {
      "Sid": "PricingRead",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem"
      ],
      "Resource": "arn:aws:dynamodb:*:<ACCOUNT_ID>:table/bedrock_pricing"
    },
    {
      "Sid": "PoliciesRead",
      "Effect": "Allow",
      "Action": [
        "dynamodb:Query"
      ],
      "Resource": "arn:aws:dynamodb:*:<ACCOUNT_ID>:table/bedrock_budget_policies"
    },
    {
      "Sid": "UsageReadWrite",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem"
      ],
      "Resource": [
        "arn:aws:dynamodb:*:<ACCOUNT_ID>:table/bedrock_usage_aggregates",
        "arn:aws:dynamodb:*:<ACCOUNT_ID>:table/bedrock_usage_events"
      ]
    }
  ]
}
```

---

## 5) Wire into app

Use the table names in `createDynamoStores` (see `examples/example-dynamodb.ts`):

```ts
const { pricingStore, policyStore, usageStore } = createDynamoStores({
  ddbClientConfig: { region: "us-east-1" },
  pricingTableName: "bedrock_pricing",
  policyTableName: "bedrock_budget_policies",
  usageAggregateTableName: "bedrock_usage_aggregates",
  usageEventTableName: "bedrock_usage_events",
});
```

---

## 6) Basic verification

1. Run one wrapped `converse` request.
2. Confirm event row exists:

```bash
aws dynamodb scan \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" \
  --table-name bedrock_usage_events \
  --max-items 5
```

3. Confirm aggregates updated:

```bash
aws dynamodb scan \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" \
  --table-name bedrock_usage_aggregates \
  --max-items 10
```

---

## 7) Notes for production hardening

- Add TTL on `bedrock_usage_events` if long-term retention is not needed.
- Add CloudWatch alarms on throttling and DynamoDB errors.
- Consider budget reservation/commit flow for tighter pre-call enforcement under high concurrency.
- Keep pricing table versioned and update when provider pricing changes.
