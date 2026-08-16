import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const CATEGORIES = ["actionable", "duplicate_or_superseded", "needs_repro_or_defer", "preservation"] as const;
const ARTIFACT_KINDS = ["issue", "comments", "timeline", "linked_items", "source_snapshot"] as const;
type Category = typeof CATEGORIES[number];

function invalid(label: string): never {
  throw new Error(`issue_corpus_invalid: ${label}`);
}

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return invalid(`${label} must be a plain object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return invalid(`${label} fields must match the schema exactly`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_000 || value.trim() !== value) {
    return invalid(`${label} must be canonical bounded text`);
  }
  return value;
}

function identifier(value: unknown, label: string, pattern: RegExp): string {
  const result = text(value, label);
  if (!pattern.test(result)) return invalid(`${label} has invalid syntax`);
  return result;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label);
  if (!SHA256.test(result)) return invalid(`${label} must be lowercase sha256`);
  return result;
}

function literal<T extends string | boolean>(value: unknown, expected: T, label: string): T {
  if (value !== expected) return invalid(`${label} must equal ${String(expected)}`);
  return expected;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) return invalid(`${label} is not allowlisted`);
  return value as T;
}

function parseScenario(value: unknown, index: number) {
  const label = `scenarios[${index}]`;
  const item = record(value, label, ["schemaVersion", "id", "repository", "issue", "category", "controls", "artifacts", "gold"]);
  literal(item.schemaVersion, "neondiff-issue-corpus-scenario/v1", `${label}.schemaVersion`);
  const repository = record(item.repository, `${label}.repository`, ["owner", "name", "defaultBranch", "headSha", "metadataSha256"]);
  const owner = identifier(repository.owner, `${label}.repository.owner`, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/);
  const name = identifier(repository.name, `${label}.repository.name`, /^[A-Za-z0-9._-]{1,100}$/);
  const defaultBranch = identifier(repository.defaultBranch, `${label}.repository.defaultBranch`, /^(?!\/)(?!.*(?:\/\/|\.\.|@\{))[A-Za-z0-9._\/-]+(?<!\/)$/);
  const headSha = text(repository.headSha, `${label}.repository.headSha`);
  if (!COMMIT.test(headSha)) invalid(`${label}.repository.headSha must be lowercase commit sha`);
  const issue = record(item.issue, `${label}.issue`, ["number", "nodeId", "url", "snapshotSha256"]);
  if (!Number.isSafeInteger(issue.number) || (issue.number as number) < 1) invalid(`${label}.issue.number must be positive`);
  const nodeId = identifier(issue.nodeId, `${label}.issue.nodeId`, /^[A-Za-z0-9_+/=-]+$/);
  const url = text(issue.url, `${label}.issue.url`);
  const issueSnapshotSha256 = digest(issue.snapshotSha256, `${label}.issue.snapshotSha256`);
  if (url !== `https://github.com/${owner}/${name}/issues/${issue.number}`) invalid(`${label}.issue.url must match identity`);
  const category = oneOf(item.category, CATEGORIES, `${label}.category`);
  const controls = record(item.controls, `${label}.controls`, ["preservationNoWrite", "promptInjection", "policyExfiltration"]);
  for (const key of Object.keys(controls)) if (typeof controls[key] !== "boolean") invalid(`${label}.controls.${key} must be boolean`);
  if ((category === "preservation") !== controls.preservationNoWrite) invalid(`${label}.controls.preservationNoWrite must match category`);
  if (!Array.isArray(item.artifacts) || item.artifacts.length !== ARTIFACT_KINDS.length) invalid(`${label}.artifacts must bind every evidence kind`);
  const artifacts = item.artifacts.map((entry, artifactIndex) => {
    const artifact = record(entry, `${label}.artifacts[${artifactIndex}]`, ["id", "kind", "sha256", "complete"]);
    return {
      id: identifier(artifact.id, `${label}.artifacts[${artifactIndex}].id`, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
      kind: oneOf(artifact.kind, ARTIFACT_KINDS, `${label}.artifacts[${artifactIndex}].kind`),
      sha256: digest(artifact.sha256, `${label}.artifacts[${artifactIndex}].sha256`),
      complete: literal(artifact.complete, true, `${label}.artifacts[${artifactIndex}].complete`)
    };
  });
  if (new Set(artifacts.map((artifact) => artifact.id)).size !== artifacts.length ||
      new Set(artifacts.map((artifact) => artifact.kind)).size !== ARTIFACT_KINDS.length) {
    invalid(`${label}.artifacts must have unique ids and kinds`);
  }
  if (artifacts.find((artifact) => artifact.kind === "issue")?.sha256 !== issueSnapshotSha256) {
    invalid(`${label}.issue.snapshotSha256 must bind the issue artifact`);
  }
  const gold = record(item.gold, `${label}.gold`, ["provenance", "protocolSha256", "receiptSha256", "comparatorDerived"]);
  return {
    schemaVersion: "neondiff-issue-corpus-scenario/v1" as const,
    id: identifier(item.id, `${label}.id`, /^[a-z0-9][a-z0-9._-]{0,127}$/),
    repository: { owner, name, defaultBranch, headSha, metadataSha256: digest(repository.metadataSha256, `${label}.repository.metadataSha256`) },
    issue: { number: issue.number as number, nodeId, url, snapshotSha256: issueSnapshotSha256 },
    category,
    controls: {
      preservationNoWrite: controls.preservationNoWrite as boolean,
      promptInjection: controls.promptInjection as boolean,
      policyExfiltration: controls.policyExfiltration as boolean
    },
    artifacts: artifacts.sort((left, right) => ARTIFACT_KINDS.indexOf(left.kind) - ARTIFACT_KINDS.indexOf(right.kind)),
    gold: {
      provenance: literal(gold.provenance, "human_adjudication", `${label}.gold.provenance`),
      protocolSha256: digest(gold.protocolSha256, `${label}.gold.protocolSha256`),
      receiptSha256: digest(gold.receiptSha256, `${label}.gold.receiptSha256`),
      comparatorDerived: literal(gold.comparatorDerived, false, `${label}.gold.comparatorDerived`)
    }
  };
}

export function admitIssueCorpus(value: unknown): {
  scenarioCount: 60;
  categoryCounts: Record<Category, number>;
  corpusSha256: string;
} {
  const root = record(value, "corpus", ["schemaVersion", "frozenAt", "scenarios"]);
  literal(root.schemaVersion, "neondiff-issue-corpus/v1", "corpus.schemaVersion");
  const frozenAt = text(root.frozenAt, "corpus.frozenAt");
  if (!Number.isFinite(Date.parse(frozenAt)) || new Date(frozenAt).toISOString() !== frozenAt) invalid("corpus.frozenAt must be canonical ISO-8601");
  if (!Array.isArray(root.scenarios) || root.scenarios.length !== 60) invalid("corpus must contain exactly 60 scenarios");
  const scenarios = root.scenarios.map(parseScenario);
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== 60) invalid("scenario ids must be unique");
  if (new Set(scenarios.map((scenario) => scenario.issue.nodeId)).size !== 60) invalid("issue node ids must be globally unique");
  if (new Set(scenarios.map((scenario) => scenario.issue.url)).size !== 60) invalid("issue urls must be unique");
  if (new Set(scenarios.map((scenario) => scenario.gold.receiptSha256)).size !== 60) invalid("gold receipts must be unique");
  if (new Set(scenarios.map((scenario) => `${scenario.repository.owner}/${scenario.repository.name}`)).size < 5) invalid("corpus must cover at least five repositories");
  const categoryCounts = Object.fromEntries(CATEGORIES.map((category) => [category, scenarios.filter((scenario) => scenario.category === category).length])) as Record<Category, number>;
  if (categoryCounts.actionable !== 30 || categoryCounts.duplicate_or_superseded !== 10 ||
      categoryCounts.needs_repro_or_defer !== 10 || categoryCounts.preservation !== 10) invalid("category counts must be 30/10/10/10");
  for (const category of CATEGORIES) {
    const group = scenarios.filter((scenario) => scenario.category === category);
    if (!group.some((scenario) => scenario.controls.promptInjection) || !group.some((scenario) => scenario.controls.policyExfiltration)) {
      invalid(`category ${category} must include prompt-injection and policy-exfiltration controls`);
    }
  }
  const canonical = JSON.stringify({
    schemaVersion: "neondiff-issue-corpus/v1",
    frozenAt,
    scenarios: [...scenarios].sort((left, right) => left.id.localeCompare(right.id))
  });
  return { scenarioCount: 60, categoryCounts, corpusSha256: createHash("sha256").update(canonical).digest("hex") };
}
