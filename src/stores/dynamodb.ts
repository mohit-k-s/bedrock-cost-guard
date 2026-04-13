import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  BudgetPolicy,
  CostWindow,
  InvokeContext,
  PolicyStore,
  Pricing,
  PricingStore,
  UsageAggregate,
  UsageRecord,
  UsageStore,
} from "../types.js";

type DynamoStoresConfig = {
  ddbClient?: DynamoDBDocumentClient;
  ddbClientConfig?: DynamoDBClientConfig;
  pricingTableName: string;
  policyTableName: string;
  usageAggregateTableName: string;
  usageEventTableName: string;
};

export function createDocumentClient(config?: DynamoDBClientConfig): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient(config ?? {}), {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  });
}

export class DynamoPricingStore implements PricingStore {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly tableName: string) {}

  async get(modelId: string): Promise<Pricing | null> {
    const out = await this.ddb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { modelId },
      })
    );

    if (!out.Item) return null;

    return {
      modelId: String(out.Item.modelId),
      inputPer1kUsd: Number(out.Item.inputPer1kUsd),
      outputPer1kUsd: Number(out.Item.outputPer1kUsd),
      currency: "USD",
      effectiveFrom: out.Item.effectiveFrom ? String(out.Item.effectiveFrom) : undefined,
    };
  }
}

export class DynamoPolicyStore implements PolicyStore {
  constructor(private readonly ddb: DynamoDBDocumentClient, private readonly tableName: string) {}

  async getPoliciesForContext(context: InvokeContext): Promise<BudgetPolicy[]> {
    const [teamPolicies, userPolicies] = await Promise.all([
      this.queryScope("team", context.teamId),
      this.queryScope("user", context.userId),
    ]);
    return [...teamPolicies, ...userPolicies];
  }

  private async queryScope(scope: "team" | "user", scopeId: string): Promise<BudgetPolicy[]> {
    const pk = `${scope}#${scopeId}`;
    const out = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": pk,
        },
      })
    );

    return (out.Items ?? []).map((item) => ({
      scope,
      scopeId,
      perRequestLimitUsd: numberOrUndefined(item.perRequestLimitUsd),
      dailyLimitUsd: numberOrUndefined(item.dailyLimitUsd),
      monthlyLimitUsd: numberOrUndefined(item.monthlyLimitUsd),
      softThresholdPct: numberOrUndefined(item.softThresholdPct),
      allowedModelIds: Array.isArray(item.allowedModelIds)
        ? item.allowedModelIds.map((x: unknown) => String(x))
        : undefined,
      preferredFallbackModelId: stringOrUndefined(item.preferredFallbackModelId),
    }));
  }
}

export class DynamoUsageStore implements UsageStore {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly aggregateTableName: string,
    private readonly eventTableName: string
  ) {}

  async getAggregate(
    scope: "user" | "team",
    scopeId: string,
    window: CostWindow,
    now: Date
  ): Promise<UsageAggregate> {
    const key = buildAggregatePk(scope, scopeId, window, now);
    const out = await this.ddb.send(
      new GetCommand({
        TableName: this.aggregateTableName,
        Key: { pk: key },
      })
    );

    if (!out.Item) return { spentUsd: 0, inputTokens: 0, outputTokens: 0 };

    return {
      spentUsd: Number(out.Item.spentUsd ?? 0),
      inputTokens: Number(out.Item.inputTokens ?? 0),
      outputTokens: Number(out.Item.outputTokens ?? 0),
    };
  }

  async recordUsage(record: UsageRecord): Promise<void> {
    const timestamp = record.timestamp;
    const now = new Date(timestamp);

    await this.ddb.send(
      new PutCommand({
        TableName: this.eventTableName,
        Item: {
          pk: `request#${record.requestId}`,
          requestId: record.requestId,
          timestamp,
          userId: record.context.userId,
          teamId: record.context.teamId,
          appId: record.context.appId,
          feature: record.context.feature,
          priority: record.context.priority,
          modelId: record.modelId,
          estimatedUsd: record.estimatedUsd,
          actualUsd: record.actualUsd,
          inputTokens: record.usage.inputTokens,
          outputTokens: record.usage.outputTokens,
          decisionAllow: record.decision.allow,
          decisionReason: record.decision.reason,
          decisionModelId: "modelId" in record.decision ? record.decision.modelId : undefined,
          metadata: record.context.metadata,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      })
    );

    const updates = [
      this.updateAggregate("user", record.context.userId, "daily", now, record),
      this.updateAggregate("user", record.context.userId, "monthly", now, record),
      this.updateAggregate("team", record.context.teamId, "daily", now, record),
      this.updateAggregate("team", record.context.teamId, "monthly", now, record),
    ];

    await Promise.all(updates);
  }

  private async updateAggregate(
    scope: "user" | "team",
    scopeId: string,
    window: CostWindow,
    now: Date,
    record: UsageRecord
  ): Promise<void> {
    const pk = buildAggregatePk(scope, scopeId, window, now);

    await this.ddb.send(
      new UpdateCommand({
        TableName: this.aggregateTableName,
        Key: { pk },
        UpdateExpression:
          "SET #scope = :scope, #scopeId = :scopeId, #window = :window, #windowKey = :windowKey, #updatedAt = :updatedAt " +
          "ADD #spentUsd :spentUsd, #inputTokens :inputTokens, #outputTokens :outputTokens, #requestCount :requestCount",
        ExpressionAttributeNames: {
          "#scope": "scope",
          "#scopeId": "scopeId",
          "#window": "window",
          "#windowKey": "windowKey",
          "#updatedAt": "updatedAt",
          "#spentUsd": "spentUsd",
          "#inputTokens": "inputTokens",
          "#outputTokens": "outputTokens",
          "#requestCount": "requestCount",
        },
        ExpressionAttributeValues: {
          ":scope": scope,
          ":scopeId": scopeId,
          ":window": window,
          ":windowKey": buildWindowKey(window, now),
          ":updatedAt": record.timestamp,
          ":spentUsd": record.actualUsd,
          ":inputTokens": record.usage.inputTokens,
          ":outputTokens": record.usage.outputTokens,
          ":requestCount": 1,
        },
      })
    );
  }
}

export function createDynamoStores(config: DynamoStoresConfig): {
  pricingStore: DynamoPricingStore;
  policyStore: DynamoPolicyStore;
  usageStore: DynamoUsageStore;
  ddb: DynamoDBDocumentClient;
} {
  const ddb = config.ddbClient ?? createDocumentClient(config.ddbClientConfig);

  return {
    pricingStore: new DynamoPricingStore(ddb, config.pricingTableName),
    policyStore: new DynamoPolicyStore(ddb, config.policyTableName),
    usageStore: new DynamoUsageStore(ddb, config.usageAggregateTableName, config.usageEventTableName),
    ddb,
  };
}

function buildWindowKey(window: CostWindow, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return window === "daily" ? `${y}-${m}-${d}` : `${y}-${m}`;
}

function buildAggregatePk(scope: "user" | "team", scopeId: string, window: CostWindow, now: Date): string {
  return `${scope}#${scopeId}#${window}#${buildWindowKey(window, now)}`;
}

function numberOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function stringOrUndefined(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v);
}
