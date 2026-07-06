import { isSameHostOrSubdomain } from "./url-safety.js";

export type GitNexusRefreshAction = "analyze_with_embeddings" | "index_only_fallback" | "blocked";

export interface GitNexusRefreshPreflightInput {
  repoAlias?: string;
  repoPath?: string;
  indexInfoText?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  indexOnlyFallback?: boolean;
  allowDimensionChange?: boolean;
}

export interface GitNexusRefreshPreflightResult {
  ok: boolean;
  action: GitNexusRefreshAction;
  repoAlias?: string;
  current: {
    dimensions?: number;
  };
  intended: {
    provider?: string;
    model?: string;
    dimensions?: number;
  };
  recommendedCommand: string;
  warnings: string[];
  errors: string[];
}

export function buildGitNexusRefreshPreflight(input: GitNexusRefreshPreflightInput): GitNexusRefreshPreflightResult {
  const repoPath = input.repoPath ?? ".";
  const indexInfoText = input.indexInfoText ?? "";
  const currentDimensions = parseGitNexusIndexDimensions(indexInfoText);
  const intended = resolveIntendedEmbeddingConfig(input.env ?? process.env);
  const publicIntended = toPublicIntendedEmbeddingConfig(intended);
  const warnings: string[] = [];
  const errors: string[] = parseGitNexusCommandFailures(indexInfoText);
  const providerConfigMissing = !intended.provider && !intended.model;
  const currentDimensionsMissing = currentDimensions === undefined;

  if (intended.dimensionsText !== undefined && intended.dimensions === undefined) {
    errors.push("GITNEXUS_EMBEDDING_DIMS must be a positive integer");
  } else if (!intended.dimensions) {
    errors.push("GITNEXUS_EMBEDDING_DIMS is required before running gitnexus analyze --embeddings");
  }
  if (!intended.provider && !intended.model) {
    errors.push("GITNEXUS_EMBEDDING_PROVIDER, GITNEXUS_EMBEDDING_MODEL, or GITNEXUS_EMBEDDING_URL is required before running gitnexus analyze --embeddings");
  }
  if (currentDimensionsMissing) {
    errors.push("current index embedding dimensions are required before running gitnexus analyze --embeddings");
  }
  if (
    currentDimensions !== undefined &&
    intended.dimensions !== undefined &&
    currentDimensions !== intended.dimensions &&
    !input.allowDimensionChange
  ) {
    errors.push(`intended dimensions ${intended.dimensions} do not match current index dimensions ${currentDimensions}`);
  }

  if (errors.length > 0) {
    if (input.indexOnlyFallback) {
      warnings.push(providerConfigMissing
        ? "provider configuration missing; using index-only fallback to avoid changing embedding dimensions"
        : "embedding refresh unsafe; using index-only fallback to avoid changing embedding dimensions");
      warnings.push(...errors);
      return {
        ok: true,
        action: "index_only_fallback",
        ...(input.repoAlias ? { repoAlias: input.repoAlias } : {}),
        current: {
          ...(currentDimensions !== undefined ? { dimensions: currentDimensions } : {})
        },
        intended: publicIntended,
        recommendedCommand: formatGitNexusAnalyzeCommand({ repoPath, repoAlias: input.repoAlias, indexOnly: true }),
        warnings,
        errors: []
      };
    }
    return {
      ok: false,
      action: "blocked",
      ...(input.repoAlias ? { repoAlias: input.repoAlias } : {}),
      current: {
        ...(currentDimensions !== undefined ? { dimensions: currentDimensions } : {})
      },
      intended: publicIntended,
      recommendedCommand: formatGitNexusAnalyzeCommand({ repoPath, repoAlias: input.repoAlias, indexOnly: true }),
      warnings,
      errors
    };
  }

  return {
    ok: true,
    action: "analyze_with_embeddings",
    ...(input.repoAlias ? { repoAlias: input.repoAlias } : {}),
    current: {
      ...(currentDimensions !== undefined ? { dimensions: currentDimensions } : {})
    },
    intended: publicIntended,
    recommendedCommand: formatGitNexusAnalyzeCommand({
      repoPath,
      repoAlias: input.repoAlias,
      embeddings: true,
      allowDimensionChange: input.allowDimensionChange === true
    }),
    warnings,
    errors
  };
}

export function parseGitNexusIndexDimensions(text: string): number | undefined {
  const patterns = [
    /\bembeddingDimensions\s*[:=]\s*(\d+)\b/i,
    /\bembedding[_ -]?dimensions\s*[:=]\s*(\d+)\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

export function formatGitNexusAnalyzeCommand(input: {
  repoPath: string;
  repoAlias?: string;
  embeddings?: boolean;
  indexOnly?: boolean;
  allowDimensionChange?: boolean;
}): string {
  const flags = [
    input.repoAlias ? "--name" : undefined,
    input.repoAlias ? shellQuote(input.repoAlias) : undefined,
    input.embeddings ? "--embeddings" : undefined,
    input.allowDimensionChange ? "--allow-dimension-change" : undefined,
    input.allowDimensionChange ? "true" : undefined,
    input.indexOnly ? "--index-only" : undefined
  ].filter(Boolean);
  return ["gitnexus", "analyze", shellQuote(input.repoPath), ...flags].join(" ");
}

function resolveIntendedEmbeddingConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): {
  provider?: string;
  model?: string;
  dimensions?: number;
  dimensionsText?: string;
} {
  const dimensionsText = env.GITNEXUS_EMBEDDING_DIMS ?? env.GITNEXUS_EMBEDDING_DIMENSIONS;
  const dimensions = dimensionsText && /^[1-9]\d*$/.test(dimensionsText) ? Number(dimensionsText) : undefined;
  const model = env.GITNEXUS_EMBEDDING_MODEL;
  const provider = env.GITNEXUS_EMBEDDING_PROVIDER ?? inferProviderFromUrl(env.GITNEXUS_EMBEDDING_URL);
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(Number.isInteger(dimensions) && dimensions! > 0 ? { dimensions } : {}),
    ...(dimensionsText !== undefined ? { dimensionsText } : {})
  };
}

function toPublicIntendedEmbeddingConfig(input: {
  provider?: string;
  model?: string;
  dimensions?: number;
}): GitNexusRefreshPreflightResult["intended"] {
  return {
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.dimensions !== undefined ? { dimensions: input.dimensions } : {})
  };
}

function parseGitNexusCommandFailures(text: string): string[] {
  const failures: string[] = [];
  const patterns = [
    {
      command: "status",
      exit: /\[gitnexus status exit status=([^\s\]]+) signal=([^\]]+)\]/i,
      error: /\[gitnexus status error code=([^\s\]]+) message=([^\]]+)\]/i
    },
    {
      command: "doctor",
      exit: /\[gitnexus doctor exit status=([^\s\]]+) signal=([^\]]+)\]/i,
      error: /\[gitnexus doctor error code=([^\s\]]+) message=([^\]]+)\]/i
    }
  ];
  for (const pattern of patterns) {
    const exit = text.match(pattern.exit);
    const error = text.match(pattern.error);
    const status = exit?.[1] && exit[1] !== "0" && exit[1] !== "null" ? `status=${exit[1]}` : undefined;
    const signal = exit?.[2] && exit[2] !== "null" ? `signal=${exit[2]}` : undefined;
    const errorDetail = error?.[1] ? `error=${error[1]}${error[2] ? ` ${error[2]}` : ""}` : undefined;
    const parts = [status, signal, errorDetail].filter(Boolean);
    if (parts.length > 0) failures.push(`gitnexus ${pattern.command} failed: ${parts.join("; ")}`);
  }
  return failures;
}

function inferProviderFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "http";
  }
  if (isSameHostOrSubdomain(parsed.hostname, "voyageai.com")) return "voyage";
  if (isSameHostOrSubdomain(parsed.hostname, "openai.com")) return "openai";
  return "http";
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
