import type {
  BudgetDecision,
  BudgetEvaluationInput,
  BudgetPolicy,
  CostWindow,
  PolicyStore,
  UsageStore,
} from "./types.js";

export class PolicyEngine {
  constructor(private readonly policyStore: PolicyStore, private readonly usageStore: UsageStore) {}

  async evaluate(input: BudgetEvaluationInput): Promise<BudgetDecision> {
    if (!input.context.userId || !input.context.teamId) {
      return { allow: false, reason: "missing_context" };
    }

    const policies = await this.policyStore.getPoliciesForContext(input.context);
    const relevant = this.filterRelevantPolicies(policies, input.context.userId, input.context.teamId);

    for (const policy of relevant) {
      if (policy.allowedModelIds?.length && !policy.allowedModelIds.includes(input.modelId)) {
        return { allow: false, reason: "model_not_allowed" };
      }

      if (policy.perRequestLimitUsd !== undefined && input.estimatedUsd > policy.perRequestLimitUsd) {
        if (policy.preferredFallbackModelId && policy.preferredFallbackModelId !== input.modelId) {
          return { allow: true, reason: "fallback_model", modelId: policy.preferredFallbackModelId };
        }
        return { allow: false, reason: "per_request_limit" };
      }

      const dailyExceeded = await this.isWindowExceeded(policy, input, "daily");
      if (dailyExceeded) return { allow: false, reason: "daily_limit" };

      const monthlyExceeded = await this.isWindowExceeded(policy, input, "monthly");
      if (monthlyExceeded) return { allow: false, reason: "monthly_limit" };

      if (policy.softThresholdPct !== undefined) {
        const isSoft = await this.isSoftThresholdReached(policy, input);
        if (isSoft && policy.preferredFallbackModelId && policy.preferredFallbackModelId !== input.modelId) {
          return { allow: true, reason: "fallback_model", modelId: policy.preferredFallbackModelId };
        }
        if (isSoft) {
          return { allow: true, reason: "soft_threshold" };
        }
      }
    }

    return { allow: true, reason: "allow" };
  }

  private filterRelevantPolicies(policies: BudgetPolicy[], userId: string, teamId: string): BudgetPolicy[] {
    return policies.filter((policy) => {
      if (policy.scope === "user") return policy.scopeId === userId;
      return policy.scopeId === teamId;
    });
  }

  private async isWindowExceeded(policy: BudgetPolicy, input: BudgetEvaluationInput, window: CostWindow): Promise<boolean> {
    const limit = window === "daily" ? policy.dailyLimitUsd : policy.monthlyLimitUsd;
    if (limit === undefined) return false;

    const aggregate = await this.usageStore.getAggregate(policy.scope, policy.scopeId, window, input.now);
    return aggregate.spentUsd + input.estimatedUsd > limit;
  }

  private async isSoftThresholdReached(policy: BudgetPolicy, input: BudgetEvaluationInput): Promise<boolean> {
    const pct = policy.softThresholdPct;
    if (pct === undefined) return false;

    const limit = policy.monthlyLimitUsd ?? policy.dailyLimitUsd;
    if (limit === undefined || limit <= 0) return false;

    const window: CostWindow = policy.monthlyLimitUsd !== undefined ? "monthly" : "daily";
    const aggregate = await this.usageStore.getAggregate(policy.scope, policy.scopeId, window, input.now);

    return ((aggregate.spentUsd + input.estimatedUsd) / limit) * 100 >= pct;
  }
}
