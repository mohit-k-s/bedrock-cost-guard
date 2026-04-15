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

function windowKey(window: CostWindow, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return window === "daily" ? `${y}-${m}-${d}` : `${y}-${m}`;
}

function aggregateKey(scope: "user" | "team", scopeId: string, window: CostWindow, now: Date): string {
  return `${scope}:${scopeId}:${window}:${windowKey(window, now)}`;
}

export class InMemoryPricingStore implements PricingStore {
  private readonly pricingByModel = new Map<string, Pricing>();

  constructor(pricing: Pricing[]) {
    for (const item of pricing) this.pricingByModel.set(item.modelId, item);
  }

  async get(modelId: string): Promise<Pricing | null> {
    return this.pricingByModel.get(modelId) ?? null;
  }

  set(pricing: Pricing): void {
    this.pricingByModel.set(pricing.modelId, pricing);
  }

  getAll(): Pricing[] {
    return [...this.pricingByModel.values()];
  }
}

export class InMemoryPolicyStore implements PolicyStore {
  private readonly policies: BudgetPolicy[];

  constructor(policies: BudgetPolicy[]) {
    this.policies = [...policies];
  }

  async getPoliciesForContext(context: InvokeContext): Promise<BudgetPolicy[]> {
    return this.policies.filter((policy) => {
      if (policy.scope === "team") return policy.scopeId === context.teamId;
      return policy.scopeId === context.userId;
    });
  }

  setPolicies(policies: BudgetPolicy[]): void {
    this.policies.length = 0;
    this.policies.push(...policies);
  }

  getAll(): BudgetPolicy[] {
    return [...this.policies];
  }
}

export class InMemoryUsageStore implements UsageStore {
  private readonly aggregates = new Map<string, UsageAggregate>();
  private readonly events: UsageRecord[] = [];

  async getAggregate(scope: "user" | "team", scopeId: string, window: CostWindow, now: Date): Promise<UsageAggregate> {
    const key = aggregateKey(scope, scopeId, window, now);
    return this.aggregates.get(key) ?? { spentUsd: 0, inputTokens: 0, outputTokens: 0 };
  }

  async recordUsage(record: UsageRecord): Promise<void> {
    this.events.push(record);
    const ts = new Date(record.timestamp);

    for (const scope of [
      { kind: "user" as const, id: record.context.userId },
      { kind: "team" as const, id: record.context.teamId },
    ]) {
      for (const window of ["daily", "monthly"] as const) {
        const key = aggregateKey(scope.kind, scope.id, window, ts);
        const current = this.aggregates.get(key) ?? { spentUsd: 0, inputTokens: 0, outputTokens: 0 };
        this.aggregates.set(key, {
          spentUsd: round(current.spentUsd + record.actualUsd),
          inputTokens: current.inputTokens + record.usage.inputTokens,
          outputTokens: current.outputTokens + record.usage.outputTokens,
        });
      }
    }
  }

  getEvents(): UsageRecord[] {
    return [...this.events];
  }

  getAggregates(): Array<{
    key: string;
    value: UsageAggregate;
  }> {
    return [...this.aggregates.entries()].map(([key, value]) => ({
      key,
      value: { ...value },
    }));
  }
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
