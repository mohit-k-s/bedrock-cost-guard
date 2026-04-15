export type Priority = "low" | "normal" | "high";

export type InvokeContext = {
  userId: string;
  teamId: string;
  appId?: string;
  feature?: string;
  priority?: Priority;
  metadata?: Record<string, string>;
};

export type CostWindow = "daily" | "monthly";

export type BudgetPolicy = {
  scope: "user" | "team";
  scopeId: string;
  perRequestLimitUsd?: number;
  dailyLimitUsd?: number;
  monthlyLimitUsd?: number;
  softThresholdPct?: number;
  allowedModelIds?: string[];
  preferredFallbackModelId?: string;
};

export type Pricing = {
  modelId: string;
  inputPer1kUsd: number;
  outputPer1kUsd: number;
  currency: "USD";
  effectiveFrom?: string;
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
};

export type UsageAggregate = {
  spentUsd: number;
  inputTokens: number;
  outputTokens: number;
};

export type BudgetDecision =
  | {
      allow: true;
      reason: "allow" | "soft_threshold" | "fallback_model";
      modelId?: string;
    }
  | {
      allow: false;
      reason:
        | "missing_context"
        | "model_not_allowed"
        | "conflicting_fallback_models"
        | "per_request_limit"
        | "daily_limit"
        | "monthly_limit";
    };

export type BudgetEvaluationInput = {
  context: InvokeContext;
  modelId: string;
  estimatedUsd: number;
  now: Date;
};

export type UsageRecord = {
  requestId: string;
  context: InvokeContext;
  modelId: string;
  estimatedUsd: number;
  actualUsd: number;
  usage: Usage;
  decision: BudgetDecision;
  timestamp: string;
};

export interface PricingStore {
  get(modelId: string): Promise<Pricing | null>;
}

export interface PolicyStore {
  getPoliciesForContext(context: InvokeContext): Promise<BudgetPolicy[]>;
}

export interface UsageStore {
  getAggregate(scope: "user" | "team", scopeId: string, window: CostWindow, now: Date): Promise<UsageAggregate>;
  recordUsage(record: UsageRecord): Promise<void>;
}

export interface UsageExtractor<TResponse> {
  extract(response: TResponse): Usage;
}
