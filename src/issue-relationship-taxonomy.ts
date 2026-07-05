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
  const groups = new Map<string, ClassifiedIssueRelationshipItem[]>();
  for (const item of input.items) {
    const key = clusterKey(item);
    const group = groups.get(key) ?? [];
    group.push(classifyIssueRelationshipItem(item));
    groups.set(key, group);
  }

  const clusters = Array.from(groups.entries()).map(([id, items]) => {
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
  return inferred === "needs_human_routing" && input.categoryHint && !hasHumanRoutingSignal(searchableText(input)) ? input.categoryHint : inferred;
}

function inferRelationshipCategory(input: IssueRelationshipItemInput): IssueRelationshipCategoryId {
  const haystack = searchableText(input);
  if (input.severity === "P0" || input.severity === "P1" || matchesAny(haystack, ["blocks merge", "blocking", "must fix"])) {
    return "blocker";
  }
  // Missing proof wins over dependency ownership so implementation is not assigned before a reproducible case exists.
  if (matchesAny(haystack, ["reproduction gap", "missing reproduction", "no reproduction", "lacks proof", "missing proof", "missing evidence", "no command", "no head sha", "no fixture", "needs proof"])) {
    return "reproduction_gap";
  }
  if (hasReleaseRiskSignal(haystack)) return "release_risk";
  if (input.duplicateOf || matchesAny(haystack, ["stale duplicate", "duplicate of", "superseded by", "already covered"])) return "stale_duplicate";
  const paths = input.paths ?? [];
  const docsOnlyByPath = isDocsOnly(paths);
  const docsOnlyByText = matchesAny(haystack, ["docs-only", "documentation-only"]);
  if (docsOnlyByPath || (docsOnlyByText && paths.length === 0)) return "docs_only";
  if (matchesAny(haystack, ["dependency", "depends on", "blocked by", "upstream", "package update"]) || hasDependencyPath(paths)) {
    return "dependency";
  }
  if (hasRegressionSignal(haystack)) return "regression";
  if (hasHumanRoutingSignal(haystack)) return "needs_human_routing";
  return "needs_human_routing";
}

function hasReleaseRiskSignal(text: string): boolean {
  return matchesAny(text, [
    "release blocker",
    "release gate",
    "release risk",
    "release regression",
    "beta tag gate",
    "beta tag blocker",
    "beta release gate",
    "beta release blocker",
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

function hasHumanRoutingSignal(text: string): boolean {
  return matchesAny(text, ["manual triage", "needs human", "human routing", "ambiguous owner", "unknown owner"]);
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
  return standaloneClusterId(input.id);
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
  // dependsOn and blockedBy are cluster relationships; relatedRefs is the public evidence channel for routing signals.
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
  const relationshipValues = relationshipRefValues(input);
  return Boolean(
    input.privateEvidence?.length ||
    input.rawLogs?.length ||
    input.localPaths?.length ||
    input.tokens?.length ||
    input.paths?.some(isLocalPath) ||
    relationshipValues.some((value) => isPrivateRelationshipValue(value)) ||
    containsSecretLikeText([
      input.title,
      input.body ?? "",
      input.publicSummary ?? "",
      input.url ?? "",
      ...(input.paths ?? []),
      ...(input.labels ?? []),
      ...(input.evidenceUrls ?? []),
      ...(input.suggestedLabels ?? []),
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
  // Suggested reviewers are individual GitHub logins only; team slugs need a separate public field before support.
  return unique(values.map((value) => value.trim().replace(/^@/, "")).filter((value) => /^[A-Za-z0-9-]{1,39}$/.test(value)));
}

function firstPublicId(values: string[]): string | undefined {
  for (const value of values) {
    if (isPrivateRelationshipValue(value)) continue;
    const redacted = redactLocalPathLikeText(redactSecrets(value.trim()));
    if (redacted.includes("[local-path-redacted]")) continue;
    const id = sanitizeId(redacted);
    if (id) return id;
  }
  return undefined;
}

function relationshipRefValues(input: IssueRelationshipItemInput): string[] {
  return [
    ...(input.relationshipKeys ?? []),
    ...(input.duplicateOf ? [input.duplicateOf] : []),
    ...(input.dependsOn ?? []),
    ...(input.blockedBy ?? []),
    ...(input.relatedRefs ?? [])
  ];
}

function isPrivateRelationshipValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || isLocalPath(trimmed) || containsSecretLikeText(trimmed)) return true;
  if (/^https?:/i.test(trimmed) && !isSafePublicUrl(trimmed)) return true;
  return false;
}

function sanitizeId(value: string): string {
  return redactSecrets(value).trim().replace(/[^A-Za-z0-9_.:-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function standaloneClusterId(value: string): string {
  const redacted = redactSecrets(value).trim();
  const sanitized = sanitizeId(value) || "item";
  const suffix = redacted === sanitized ? "" : `-${shortStableHash(redacted)}`;
  return `standalone-${sanitized}${suffix}`;
}

function shortStableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0").slice(0, 7);
}

function isSafePublicUrl(value: string): boolean {
  if (containsSecretLikeText(value)) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (isPrivateOrLocalHostname(hostname)) return false;
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.includes(":") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
  );
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
  /(^|[\s([{"'`=,;?])(?:file:\/\/[^\s,;]+|\\\\[^\s,;]+|~(?:[\\/][^\s,;]*)?|\/(?!\/)[^\s,;]+|[A-Za-z]:(?:[\\/][^\s,;]*|[^\s,;]+))/g;

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
