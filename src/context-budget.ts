import type { PullFilePatch } from "./types.js";

export type ContextBudgetOverflowPolicy = "skip" | "chunk";

export interface ContextBudgetConfig {
  enabled: boolean;
  overflow: ContextBudgetOverflowPolicy;
  reservedOutputTokens: number;
  charsPerToken: number;
  providerFudgeFactor: number;
  maxChunks: number;
}

export const DEFAULT_CONTEXT_BUDGET_CONFIG: ContextBudgetConfig = {
  enabled: true,
  overflow: "skip",
  reservedOutputTokens: 4_096,
  charsPerToken: 4,
  providerFudgeFactor: 1.15,
  maxChunks: 8
};

export interface ContextBudgetChunk {
  index: number;
  files: PullFilePatch[];
  filenames: string[];
  estimatedTokens: number;
}

export type ContextBudgetPlan =
  | {
      mode: "disabled";
      estimatedTokens: number;
      reservedOutputTokens: number;
      overflow: ContextBudgetOverflowPolicy;
      contextWindowTokens?: undefined;
      budgetTokens?: undefined;
      chunks?: undefined;
      reason: "context_budget_disabled";
    }
  | {
      mode: "unknown_window";
      estimatedTokens: number;
      reservedOutputTokens: number;
      overflow: ContextBudgetOverflowPolicy;
      contextWindowTokens?: undefined;
      budgetTokens?: undefined;
      chunks?: undefined;
      reason: "context_window_tokens_not_configured";
    }
  | {
      mode: "within_budget";
      estimatedTokens: number;
      reservedOutputTokens: number;
      overflow: ContextBudgetOverflowPolicy;
      contextWindowTokens: number;
      budgetTokens: number;
      chunks?: undefined;
      reason: "context_budget_within_budget";
    }
  | {
      mode: "skip";
      estimatedTokens: number;
      reservedOutputTokens: number;
      overflow: ContextBudgetOverflowPolicy;
      contextWindowTokens?: number;
      budgetTokens?: number;
      reason:
        | "context_budget_overflow"
        | "context_budget_no_available_input_tokens"
        | "context_budget_single_file_overflow"
        | "context_budget_chunk_count_exceeded";
      chunks?: undefined;
    }
  | {
      mode: "chunk";
      estimatedTokens: number;
      reservedOutputTokens: number;
      overflow: "chunk";
      contextWindowTokens: number;
      budgetTokens: number;
      chunks: ContextBudgetChunk[];
      reason: "context_budget_overflow";
    };

export function estimateContextTokens(input: string, options: {
  charsPerToken: number;
  providerFudgeFactor: number;
}): number {
  const charsPerToken = Math.max(1, options.charsPerToken);
  const providerFudgeFactor = Math.max(0.01, options.providerFudgeFactor);
  return Math.ceil((input.length / charsPerToken) * providerFudgeFactor);
}

export function normalizeContextBudgetConfig(config?: Partial<ContextBudgetConfig>): ContextBudgetConfig {
  return {
    ...DEFAULT_CONTEXT_BUDGET_CONFIG,
    ...(config ?? {})
  };
}

export function planContextBudget(input: {
  prompt: string;
  files: PullFilePatch[];
  contextWindowTokens?: number;
  config?: Partial<ContextBudgetConfig>;
  buildPrompt: (files: PullFilePatch[]) => string;
}): ContextBudgetPlan {
  const config = normalizeContextBudgetConfig(input.config);
  const estimatedTokens = estimateContextTokens(input.prompt, config);
  const base = {
    estimatedTokens,
    reservedOutputTokens: config.reservedOutputTokens,
    overflow: config.overflow
  } as const;

  if (!config.enabled) {
    return {
      ...base,
      mode: "disabled",
      reason: "context_budget_disabled"
    };
  }

  if (!input.contextWindowTokens) {
    return {
      ...base,
      mode: "unknown_window",
      reason: "context_window_tokens_not_configured"
    };
  }

  const budgetTokens = input.contextWindowTokens - config.reservedOutputTokens;
  if (budgetTokens < 1) {
    return {
      ...base,
      mode: "skip",
      contextWindowTokens: input.contextWindowTokens,
      budgetTokens,
      reason: "context_budget_no_available_input_tokens"
    };
  }

  if (estimatedTokens <= budgetTokens) {
    return {
      ...base,
      mode: "within_budget",
      contextWindowTokens: input.contextWindowTokens,
      budgetTokens,
      reason: "context_budget_within_budget"
    };
  }

  if (config.overflow === "skip") {
    return {
      ...base,
      mode: "skip",
      contextWindowTokens: input.contextWindowTokens,
      budgetTokens,
      reason: "context_budget_overflow"
    };
  }

  const chunks = buildFileBoundaryChunks({
    files: input.files,
    budgetTokens,
    config,
    buildPrompt: input.buildPrompt
  });
  if (chunks.reason) {
    return {
      ...base,
      mode: "skip",
      contextWindowTokens: input.contextWindowTokens,
      budgetTokens,
      reason: chunks.reason
    };
  }

  return {
    ...base,
    mode: "chunk",
    contextWindowTokens: input.contextWindowTokens,
    budgetTokens,
    chunks: chunks.chunks,
    reason: "context_budget_overflow",
    overflow: "chunk"
  };
}

function buildFileBoundaryChunks(input: {
  files: PullFilePatch[];
  budgetTokens: number;
  config: ContextBudgetConfig;
  buildPrompt: (files: PullFilePatch[]) => string;
}): { chunks: ContextBudgetChunk[]; reason?: undefined } | {
  chunks?: undefined;
  reason: "context_budget_single_file_overflow" | "context_budget_chunk_count_exceeded";
} {
  const chunks: ContextBudgetChunk[] = [];
  let current: PullFilePatch[] = [];

  for (const file of input.files) {
    const singleEstimate = estimateContextTokens(input.buildPrompt([file]), input.config);
    if (singleEstimate > input.budgetTokens) {
      return { reason: "context_budget_single_file_overflow" };
    }

    const candidate = [...current, file];
    const candidateEstimate = estimateContextTokens(input.buildPrompt(candidate), input.config);
    if (current.length > 0 && candidateEstimate > input.budgetTokens) {
      chunks.push(toChunk(chunks.length + 1, current, input));
      current = [file];
      continue;
    }

    current = candidate;
  }

  if (current.length > 0) chunks.push(toChunk(chunks.length + 1, current, input));
  if (chunks.length > input.config.maxChunks) return { reason: "context_budget_chunk_count_exceeded" };
  return { chunks };
}

function toChunk(index: number, files: PullFilePatch[], input: {
  config: ContextBudgetConfig;
  buildPrompt: (files: PullFilePatch[]) => string;
}): ContextBudgetChunk {
  return {
    index,
    files,
    filenames: files.map((file) => file.filename),
    estimatedTokens: estimateContextTokens(input.buildPrompt(files), input.config)
  };
}
