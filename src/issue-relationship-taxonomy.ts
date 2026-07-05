import { containsSecretLikeText, redactSecrets } from "./secrets.js";
import type { Severity } from "./types.js";

export const ISSUE_RELATIONSHIP_CATEGORIES = [
  "blocker",
  "regression",
  "reproduction_gap",
  "stale_duplicate",
  "dependency",
  "release_risk",
  "docs_only",
  "needs_human_routing"
] as const;

export type IssueRelationshipCategoryId = typeof ISSUE_RELATIONSHIP_CATEGORIES[number];

export const PROOF_REQUIREMENTS = [
  "current_head_failure",
  "regression_fixture",
  "reproduction_steps",
  "freshness_check",
  "dependency_owner",
  "release_gate",
  "docs_scope",
  "human_triage"
] as const;

export type ProofRequirementId = typeof PROOF_REQUIREMENTS[number];

export type IssueRelationshipItemKind = "issue" | "pull_request" | "finding";
export type IssueRelationshipItemState = "open" | "closed" | "merged";

export interface IssueRelationshipItemInput {
  id: string;
  kind: IssueRelationshipItemKind;
  title: string;
  body?: string;
  publicSummary?: string;
  repo?: string;
  number?: number;
  state?: IssueRelationshipItemState;
  url?: string;
  labels?: string[];
  paths?: string[];
  severity?: Severity;
  categoryHint?: IssueRelationshipCategoryId;
  relationshipKeys?: string[];
  relatedRefs?: string[];
  duplicateOf?: string;
  dependsOn?: string[];
  blockedBy?: string[];
  evidenceUrls?: string[];
  suggestedLabels?: string[];
  suggestedReviewers?: string[];
  privateEvidence?: unknown[];
  rawLogs?: unknown[];
  localPaths?: string[];
  tokens?: string[];
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string;
  mergedAt?: string;
}

export interface ClassifiedIssueRelationshipItem {
  id: string;
  kind: IssueRelationshipItemKind;
  title: string;
  summary: string;
  category: IssueRelationshipCategoryId;
  categoryHint?: IssueRelationshipCategoryId;
  categoryHintHonored?: boolean;
  proofRequirements: ProofRequirementId[];
  publicEvidenceUrls: string[];
  suggestedLabels: string[];
  suggestedReviewers: string[];
  publicPaths: string[];
  repo?: string;
  number?: number;
  state?: IssueRelationshipItemState;
  url?: string;
}

export interface PublicIssueRelationshipCluster {
  id: string;
  categories: IssueRelationshipCategoryId[];
  proofRequirements: ProofRequirementId[];
  whyItMatters: string;
  items: ClassifiedIssueRelationshipItem[];
  suggestedLabels: string[];
  suggestedReviewers: string[];
}

export interface IssueRelationshipClusterResult {
  artifactVersion: "0.1";
  publicIssueCommentState: {
    summary: string;
    clusters: PublicIssueRelationshipCluster[];
  };
  privateEvidenceBoundary: {
    rawEvidenceOmitted: boolean;
    privateEvidenceItems: number;
  };
}

export interface IssueRelationshipClusterInput {
  items: IssueRelationshipItemInput[];
}

export function classifyIssueRelationshipItem(input: IssueRelationshipItemInput): ClassifiedIssueRelationshipItem {
  const category = resolveRelationshipCategory(input);
  const proofRequirements = proofRequirementsFor(input, category);
  const categoryHintHonored = input.categoryHint ? category === input.categoryHint : undefined;
  return {
    id: sanitizeId(input.id),
    kind: input.kind,
    title: publicText(input.title),
    summary: publicText(input.publicSummary ?? input.title),
    category,
    ...(input.categoryHint ? { categoryHint: input.categoryHint, categoryHintHonored } : {}),
    proofRequirements,
    publicEvidenceUrls: publicEvidenceUrls(input.evidenceUrls ?? []),
    suggestedLabels: suggestedLabelsFor(input, category),
    suggestedReviewers: publicReviewerLogins(input.suggestedReviewers ?? []),
    publicPaths: publicPaths(input.paths ?? []),
    ...(input.repo ? { repo: publicText(input.repo) } : {}),
    ...(input.number !== undefined ? { number: input.number } : {}),
    ...(input.state ? { state: input.state } : {}),
    ...(input.url && isSafePublicUrl(input.url) ? { url: redactSecrets(input.url) } : {})
  };
}

export function buildIssueRelationshipClusters(input: IssueRelationshipClusterInput): IssueRelationshipClusterResult {
  const groups = new Map<string, Array<{ raw: IssueRelationshipItemInput; classified: ClassifiedIssueRelationshipItem }>>();
  for (const item of input.items) {
    const key = clusterKey(item);
    const group = groups.get(key) ?? [];
    group.push({ raw: item, classified: classifyIssueRelationshipItem(item) });
    groups.set(key, group);
  }

  const clusters = Array.from(groups.entries()).map(([id, entries]) => {
    const items = entries.map((entry) => entry.classified);
    const categories = unique(items.map((item) => item.category));
    const proofRequirements = unique(items.flatMap((item) => item.proofRequirements));
    return {
      id,
      categories,
      proofRequirements,
      whyItMatters: whyClusterMatters(id, items, categories, proofRequirements),
      items,
      suggestedLabels: unique(items.flatMap((item) => item.suggestedLabels)),
      suggestedReviewers: unique(items.flatMap((item) => item.suggestedReviewers))
    };
  });

  const privateEvidenceItems = input.items.filter(hasPrivateEvidence).length;
  return {
    artifactVersion: "0.1",
    publicIssueCommentState: {
      summary: `${clusters.length} relationship cluster(s) across ${input.items.length} item(s). Suggestions are advisory only and perform no target-repo mutation.`,
      clusters
    },
    privateEvidenceBoundary: {
      rawEvidenceOmitted: privateEvidenceItems > 0,
      privateEvidenceItems
    }
  };
}

function resolveRelationshipCategory(input: IssueRelationshipItemInput): IssueRelationshipCategoryId {
  const inferred = inferRelationshipCategory(input);
  return inferred === "needs_human_routing" && input.categoryHint ? input.categoryHint : inferred;
}

function inferRelationshipCategory(input: IssueRelationshipItemInput): IssueRelationshipCategoryId {
  const haystack = searchableText(input);
  if (input.severity === "P0" || input.severity === "P1" || matchesAny(haystack, ["blocks merge", "blocking", "must fix"])) {
    return "blocker";
  }
  if (hasReleaseRiskSignal(haystack)) return "release_risk";
  if (matchesAny(haystack, ["reproduction gap", "missing reproduction", "no reproduction", "lacks proof", "missing proof", "missing evidence", "no command", "no head sha", "no fixture", "needs proof"])) {
    return "reproduction_gap";
  }
  if (input.duplicateOf || matchesAny(haystack, ["stale duplicate", "duplicate of", "superseded by", "already covered"])) return "stale_duplicate";
  if (matchesAny(haystack, ["dependency", "depends on", "blocked by", "upstream", "package update"]) || hasDependencyPath(input.paths ?? [])) {
    return "dependency";
  }
  if (isDocsOnly(input.paths ?? []) || matchesAny(haystack, ["docs-only", "documentation-only"])) return "docs_only";
  if (hasRegressionSignal(haystack)) return "regression";
  if (matchesAny(haystack, ["manual triage", "needs human", "human routing", "ambiguous owner", "unknown owner"])) return "needs_human_routing";
  return "needs_human_routing";
}

function hasReleaseRiskSignal(text: string): boolean {
  return matchesAny(text, [
    "release blocker",
    "release gate",
    "release risk",
    "release regression",
    "beta tag",
    "beta release",
    "deploy release",
    "deploy blocker",
    "deployment blocker",
    "appcast",
    "notary",
    "notarize",
    "notarized",
    "notarization",
    "launchd",
    "production release",
    "production rollout",
    "publish release",
    "publish blocker",
    "rollout blocker",
    "rollout gate"
  ]);
}

function proofRequirementsFor(input: IssueRelationshipItemInput, category: IssueRelationshipCategoryId): ProofRequirementId[] {
  const requirements: ProofRequirementId[] = [];
  if (category === "blocker") requirements.push("current_head_failure");
  if (category === "regression") requirements.push("regression_fixture");
  if (category === "reproduction_gap") requirements.push("reproduction_steps");
  if (category === "stale_duplicate") requirements.push("freshness_check");
  if (category === "dependency") requirements.push("dependency_owner");
  if (category === "release_risk") requirements.push("release_gate");
  if (category === "docs_only") requirements.push("docs_scope");
  if (category === "needs_human_routing") requirements.push("human_triage");
  if (category === "release_risk" && hasRegressionSignal(searchableText(input))) {
    requirements.push("regression_fixture");
  }
  return unique(requirements);
}

function hasRegressionSignal(text: string): boolean {
  return matchesAny(text, [
    "regression",
    "regressed",
    "broke",
    "broken",
    "failing test",
    "test failure",
    "ci failure",
    "fixture update"
  ]);
}

function suggestedLabelsFor(input: IssueRelationshipItemInput, category: IssueRelationshipCategoryId): string[] {
  const explicit = publicLabels(input.suggestedLabels ?? []);
  if (category === "release_risk") return unique([...explicit, "release-risk"]);
  if (category === "blocker") return unique([...explicit, "blocker"]);
  return explicit;
}

function clusterKey(input: IssueRelationshipItemInput): string {
  const explicit = firstPublicId(input.relationshipKeys ?? []);
  if (explicit) return explicit;
  const related = firstPublicId([
    ...(input.duplicateOf ? [input.duplicateOf] : []),
    ...(input.dependsOn ?? []),
    ...(input.blockedBy ?? []),
    ...(input.relatedRefs ?? [])
  ]);
  if (related) return related;
  return `standalone-${sanitizeId(input.id)}`;
}

function whyClusterMatters(
  id: string,
  items: ClassifiedIssueRelationshipItem[],
  categories: IssueRelationshipCategoryId[],
  proofRequirements: ProofRequirementId[]
): string {
  const categoryText = categories.join(", ");
  const proofText = proofRequirements.join(", ");
  if (items.length > 1) {
    return `Multiple related records share ${id}; route them together so ${categoryText} context and ${proofText} proof requirements do not drift.`;
  }
  if (categories.includes("stale_duplicate")) return `Stale duplicate routing keeps old reports from competing with fresher proof for ${id}.`;
  if (categories.includes("release_risk")) return `Release-risk routing keeps beta, deploy, and rollback proof explicit for ${id}.`;
  if (categories.includes("reproduction_gap")) return `Proof-gap routing keeps ${id} out of implementation until reproduction evidence exists.`;
  return `Single-item routing records ${categoryText} proof requirements for ${id}.`;
}

function searchableText(input: IssueRelationshipItemInput): string {
  return [
    input.title,
    input.body ?? "",
    input.publicSummary ?? "",
    ...(input.labels ?? []),
    ...(input.paths ?? []),
    ...(input.relatedRefs ?? [])
  ].join("\n").toLowerCase();
}

function hasPrivateEvidence(input: IssueRelationshipItemInput): boolean {
  return Boolean(
    input.privateEvidence?.length ||
    input.rawLogs?.length ||
    input.localPaths?.length ||
    input.tokens?.length ||
    input.paths?.some(isLocalPath) ||
    containsSecretLikeText([
      input.title,
      input.body ?? "",
      input.publicSummary ?? "",
      input.url ?? "",
      ...(input.paths ?? []),
      ...(input.suggestedReviewers ?? [])
    ].join("\n"))
  );
}

function publicText(value: string): string {
  return redactLocalPathLikeText(redactSecrets(value)).trim();
}

function publicEvidenceUrls(values: string[]): string[] {
  return unique(values.filter(isSafePublicUrl).map(redactSecrets));
}

function publicPaths(values: string[]): string[] {
  return unique(values.map((value) => value.trim()).filter((value) => value.length > 0 && !isLocalPath(value) && !containsSecretLikeText(value)));
}

function publicLabels(values: string[]): string[] {
  return unique(values.map((value) => sanitizeId(value).toLowerCase()).filter(Boolean));
}

function publicReviewerLogins(values: string[]): string[] {
  return unique(values.map((value) => value.trim().replace(/^@/, "")).filter((value) => /^[A-Za-z0-9-]{1,39}$/.test(value)));
}

function firstPublicId(values: string[]): string | undefined {
  for (const value of values) {
    const id = sanitizeId(value);
    if (id) return id;
  }
  return undefined;
}

function sanitizeId(value: string): string {
  return redactSecrets(value).trim().replace(/[^A-Za-z0-9_.:-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function isSafePublicUrl(value: string): boolean {
  if (containsSecretLikeText(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isLocalPath(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed === "~" ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("~\\") ||
    trimmed.startsWith("file:") ||
    trimmed.startsWith("\\\\") ||
    /^[A-Za-z]:(?:[\\/]|[^\s])/.test(trimmed)
  );
}

function redactLocalPathLikeText(value: string): string {
  return value.replace(LOCAL_PATH_TEXT_PATTERN, (_match, prefix: string) => `${prefix}[local-path-redacted]`);
}

const LOCAL_PATH_TEXT_PATTERN =
  /(^|[\s([{"'`])(?:file:\/\/\S+|\\\\\S+|~(?:[\\/]\S*)?|\/(?!\/)\S+|[A-Za-z]:(?:[\\/]\S*|\S+))/g;

function isDocsOnly(paths: string[]): boolean {
  return paths.length > 0 && paths.every((path) => {
    const normalized = path.toLowerCase();
    return normalized.startsWith("docs/") || normalized.endsWith(".md") || normalized.endsWith(".mdx") || normalized === "readme.md";
  });
}

function hasDependencyPath(paths: string[]): boolean {
  return paths.some((path) => {
    const normalized = path.toLowerCase();
    return ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "requirements.txt", "poetry.lock", "cargo.lock", "go.sum"]
      .some((suffix) => normalized === suffix || normalized.endsWith(`/${suffix}`));
  });
}

function matchesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => {
    if (/[\s/_-]/.test(needle)) return text.includes(needle);
    return tokenNeedleRegExp(needle).test(text);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TOKEN_NEEDLE_REGEXPS = new Map<string, RegExp>();

function tokenNeedleRegExp(needle: string): RegExp {
  const cached = TOKEN_NEEDLE_REGEXPS.get(needle);
  if (cached) return cached;
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`);
  TOKEN_NEEDLE_REGEXPS.set(needle, pattern);
  return pattern;
}

function unique<T>(values: T[]): T[] {
  const seen = new Set<T>();
  const output: T[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}
