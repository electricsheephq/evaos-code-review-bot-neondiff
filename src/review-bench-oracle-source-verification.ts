import { createHash } from "node:crypto";
import type { ReviewBenchCorpusV1, ReviewBenchScenarioV1 } from "./review-bench-corpus.js";
import type {
  ReviewBenchSemanticEvidenceRecord
} from "./review-bench-semantic-evidence.js";
import { containsSecretLikeText } from "./secrets.js";

export const REVIEW_BENCH_ORACLE_SOURCE_VERIFIER_VERSION =
  "github-oracle-source-verifier/v1" as const;

const MAX_ORACLE_METADATA_BYTES = 512 * 1024;
const MAX_COMPARE_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_ORACLE_SOURCE_BYTES = 32 * 1024 * 1024;

export interface ReviewBenchOracleSourceVerificationRecordV1 {
  schemaVersion: "review-bench-oracle-source-verification/v1";
  verifierVersion: typeof REVIEW_BENCH_ORACLE_SOURCE_VERIFIER_VERSION;
  scenarioId: string;
  kind: "review_comment" | "later_fix" | "revert" | "test_transition" | "clean_adjudication";
  sourceRevision: string;
  sourceEvidenceSha256: string;
  metadataSha256: string;
}

export async function reverifyReviewBenchCorpusOracleSources(input: {
  corpus: ReviewBenchCorpusV1;
  semanticEvidenceRecords: ReadonlyArray<ReviewBenchSemanticEvidenceRecord>;
  admittedAt: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  verifierVersion: typeof REVIEW_BENCH_ORACLE_SOURCE_VERIFIER_VERSION;
  oracleSourceVerificationSha256: string;
  records: ReviewBenchOracleSourceVerificationRecordV1[];
}> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const evidenceByScenario = new Map<string, ReviewBenchSemanticEvidenceRecord>();
  for (const record of input.semanticEvidenceRecords) {
    if (evidenceByScenario.has(record.scenarioId)) {
      throw new Error(`duplicate semantic evidence record: ${record.scenarioId}`);
    }
    evidenceByScenario.set(record.scenarioId, record);
  }
  if (evidenceByScenario.size !== input.corpus.scenarios.length) {
    throw new Error("semantic evidence record count does not match corpus scenarios");
  }

  const records: ReviewBenchOracleSourceVerificationRecordV1[] = [];
  const scenarios = [...input.corpus.scenarios].sort((a, b) => compareFixed(a.scenarioId, b.scenarioId));
  for (const scenario of scenarios) {
    const evidence = evidenceByScenario.get(scenario.scenarioId);
    if (!evidence) throw new Error(`missing semantic evidence record: ${scenario.scenarioId}`);
    if (scenario.oracle.kind === "review_comment") {
      records.push(await verifyReviewComment(fetchImpl, scenario, evidence));
    } else if (scenario.oracle.kind === "clean_adjudication") {
      records.push(await verifyCleanObservation(fetchImpl, scenario, evidence, input.admittedAt));
    } else {
      records.push(await verifyCommitOracle(fetchImpl, scenario, evidence));
    }
  }
  return {
    verifierVersion: REVIEW_BENCH_ORACLE_SOURCE_VERIFIER_VERSION,
    oracleSourceVerificationSha256: sha256(stableJson(records)),
    records
  };
}

async function verifyCommitOracle(
  fetchImpl: typeof fetch,
  scenario: ReviewBenchScenarioV1,
  evidence: ReviewBenchSemanticEvidenceRecord
): Promise<ReviewBenchOracleSourceVerificationRecordV1> {
  const repository = scenario.repository.toLowerCase();
  const revision = scenario.oracle.sourceRevision;
  const commit = await fetchJson(
    fetchImpl,
    new URL(`https://api.github.com/repos/${repository}/commits/${revision}`),
    MAX_ORACLE_METADATA_BYTES,
    `oracle commit metadata: ${scenario.scenarioId}`
  );
  const commitRecord = requireRecord(commit, "oracle commit metadata");
  if (commitRecord.sha !== revision) throw new Error(`oracle commit sha mismatch: ${scenario.scenarioId}`);
  const commitIdentity = requireRecord(commitRecord.commit, "oracle commit identity");
  const committer = requireRecord(commitIdentity.committer, "oracle commit committer");
  const observedAt = normalizeGitHubTimestamp(committer.date, "oracle commit committer date");
  if (observedAt !== evidence.oracleObservedAt) {
    throw new Error(`oracle observedAt does not match live commit metadata: ${scenario.scenarioId}`);
  }
  const parents = requireShaArray(commitRecord.parents, "oracle commit parents");

  const comparison = await verifyAncestry(
    fetchImpl,
    scenario,
    scenario.sourceRevision,
    revision,
    `oracle commit ancestry: ${scenario.scenarioId}`
  );
  const diffBytes = await fetchBytes(
    fetchImpl,
    new URL(`https://github.com/${repository}/commit/${revision}.diff`),
    MAX_ORACLE_SOURCE_BYTES,
    `oracle commit diff: ${scenario.scenarioId}`,
    "application/vnd.github.diff"
  );
  const diffText = rejectSecretOrInvalidUtf8(diffBytes, `oracle commit diff: ${scenario.scenarioId}`);
  const sourceEvidenceSha256 = sha256(diffBytes);
  if (sourceEvidenceSha256 !== evidence.oracleSourceEvidenceSha256) {
    throw new Error(`oracle commit diff sha256 mismatch: ${scenario.scenarioId}`);
  }
  const changedPaths = collectUnifiedDiffPaths(diffText, `oracle commit diff: ${scenario.scenarioId}`);
  for (const mapping of evidence.oracleLabelEvidence) {
    if (!changedPaths.has(mapping.sourcePath)) {
      throw new Error(
        `oracle commit diff does not change mapped label-evidence path ${mapping.sourcePath}: ${scenario.scenarioId}`
      );
    }
  }
  const metadataSha256 = sha256(stableJson({
    sha: revision,
    observedAt,
    parents,
    comparison,
    sourceEvidenceSha256,
    oracleLabelEvidence: evidence.oracleLabelEvidence
  }));
  return recordFor(scenario, sourceEvidenceSha256, metadataSha256);
}

async function verifyReviewComment(
  fetchImpl: typeof fetch,
  scenario: ReviewBenchScenarioV1,
  evidence: ReviewBenchSemanticEvidenceRecord
): Promise<ReviewBenchOracleSourceVerificationRecordV1> {
  const sourceUrl = new URL(scenario.oracle.sourceUrl);
  const comment = await fetchJson(
    fetchImpl,
    sourceUrl,
    MAX_ORACLE_METADATA_BYTES,
    `oracle review comment: ${scenario.scenarioId}`
  );
  const record = requireRecord(comment, "oracle review comment");
  const commentId = Number(sourceUrl.pathname.split("/").at(-1));
  if (!Number.isSafeInteger(commentId) || record.id !== commentId) {
    throw new Error(`oracle review comment id mismatch: ${scenario.scenarioId}`);
  }
  if (record.commit_id !== scenario.sourceRevision) {
    throw new Error(`oracle review comment commit_id mismatch: ${scenario.scenarioId}`);
  }
  const repository = scenario.repository.toLowerCase();
  if (scenario.provenance.kind !== "pull_request") {
    throw new Error(`oracle review comment requires pull-request provenance: ${scenario.scenarioId}`);
  }
  const pullMatch = new URL(scenario.provenance.sourceUrl).pathname.match(/\/pull\/([1-9][0-9]*)\/?$/);
  const expectedPullRequestUrl = pullMatch
    ? `https://api.github.com/repos/${repository}/pulls/${pullMatch[1]}`
    : "";
  if (record.pull_request_url !== expectedPullRequestUrl) {
    throw new Error(`oracle review comment PR mismatch: ${scenario.scenarioId}`);
  }
  if (typeof record.path !== "string" || !isCanonicalPath(record.path) ||
      !Number.isSafeInteger(record.line) || Number(record.line) < 1 || record.side !== "RIGHT") {
    throw new Error(`oracle review comment must identify a canonical RIGHT-side line: ${scenario.scenarioId}`);
  }
  if (typeof record.body !== "string" || record.body.trim().length === 0) {
    throw new Error(`oracle review comment body is required: ${scenario.scenarioId}`);
  }
  if (containsSecretLikeText(record.body)) {
    throw new Error(`oracle review comment contains secret-like text: ${scenario.scenarioId}`);
  }
  if (evidence.oracleLabelEvidence.length !== 1 ||
      evidence.oracleLabelEvidence[0]!.sourcePath !== record.path ||
      evidence.oracleLabelEvidence[0]!.sourceLine !== record.line) {
    throw new Error(`oracle review comment location does not match label evidence: ${scenario.scenarioId}`);
  }
  const createdAt = normalizeGitHubTimestamp(record.created_at, "oracle review comment created_at");
  const updatedAt = normalizeGitHubTimestamp(record.updated_at, "oracle review comment updated_at");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error(`oracle review comment update precedes creation: ${scenario.scenarioId}`);
  }
  const observedAt = updatedAt;
  if (observedAt !== evidence.oracleObservedAt) {
    throw new Error(`oracle observedAt does not match live review comment: ${scenario.scenarioId}`);
  }
  const projection = {
    id: commentId,
    commitId: record.commit_id,
    pullRequestUrl: record.pull_request_url,
    path: record.path,
    line: record.line,
    side: record.side,
    body: record.body,
    createdAt,
    updatedAt
  };
  const sourceEvidenceSha256 = sha256(stableJson(projection));
  if (sourceEvidenceSha256 !== evidence.oracleSourceEvidenceSha256) {
    throw new Error(`oracle review comment evidence sha256 mismatch: ${scenario.scenarioId}`);
  }
  return recordFor(
    scenario,
    sourceEvidenceSha256,
    sha256(stableJson({ projection, oracleLabelEvidence: evidence.oracleLabelEvidence }))
  );
}

async function verifyCleanObservation(
  fetchImpl: typeof fetch,
  scenario: ReviewBenchScenarioV1,
  evidence: ReviewBenchSemanticEvidenceRecord,
  admittedAt: string
): Promise<ReviewBenchOracleSourceVerificationRecordV1> {
  const observation = evidence.cleanObservation;
  if (!observation) throw new Error(`clean observation is required: ${scenario.scenarioId}`);
  if (scenario.provenance.kind !== "pull_request") {
    throw new Error(`clean controls require merged pull-request provenance: ${scenario.scenarioId}`);
  }
  if (evidence.oracleSourceEvidenceSha256 !== scenario.provenance.sourceArtifactSha256) {
    throw new Error(`clean oracle must bind the reviewed source artifact: ${scenario.scenarioId}`);
  }
  const repository = scenario.repository.toLowerCase();
  const repositoryDocument = await fetchJsonDocument(
    fetchImpl,
    new URL(`https://api.github.com/repos/${repository}`),
    MAX_ORACLE_METADATA_BYTES,
    `clean repository metadata: ${scenario.scenarioId}`
  );
  const serverObservedAt = normalizeGitHubHttpDate(
    repositoryDocument.headers.get("date"),
    `clean repository metadata date: ${scenario.scenarioId}`
  );
  const normalizedAdmittedAt = normalizeGitHubTimestamp(admittedAt, "admittedAt");
  if (Math.abs(Date.parse(serverObservedAt) - Date.parse(normalizedAdmittedAt)) > 5 * 60_000) {
    throw new Error(`admittedAt must be within five minutes of GitHub server time: ${scenario.scenarioId}`);
  }
  if (Date.parse(scenario.provenance.visibilityVerifiedAt) > Date.parse(serverObservedAt) ||
      Date.parse(scenario.adjudication.completedAt) > Date.parse(serverObservedAt)) {
    throw new Error(`clean evidence timestamps must not follow GitHub server time: ${scenario.scenarioId}`);
  }
  const repositoryRecord = requireRecord(repositoryDocument.value, "clean repository metadata");
  const defaultBranch = requireCanonicalBranchName(
    repositoryRecord.default_branch,
    `clean repository default branch: ${scenario.scenarioId}`
  );
  const pullMatch = new URL(scenario.provenance.sourceUrl).pathname.match(/\/pull\/([1-9][0-9]*)\/?$/);
  if (!pullMatch) throw new Error(`clean source PR is invalid: ${scenario.scenarioId}`);
  const pullNumber = Number(pullMatch[1]);
  const pullDocument = await fetchJsonDocument(
    fetchImpl,
    new URL(`https://api.github.com/repos/${repository}/pulls/${pullNumber}`),
    MAX_ORACLE_METADATA_BYTES,
    `clean source PR metadata: ${scenario.scenarioId}`
  );
  const pull = requireRecord(pullDocument.value, "clean source PR metadata");
  const head = requireRecord(pull.head, "clean source PR head");
  const base = requireRecord(pull.base, "clean source PR base");
  const baseRepository = requireRecord(base.repo, "clean source PR base repository");
  const mergeCommitSha = requireSha(pull.merge_commit_sha, "clean source PR merge commit");
  const mergedAt = normalizeGitHubTimestamp(pull.merged_at, "clean source PR merged_at");
  if (pull.number !== pullNumber || pull.state !== "closed" || pull.merged !== true ||
      head.sha !== scenario.sourceRevision || base.ref !== defaultBranch ||
      typeof baseRepository.full_name !== "string" || baseRepository.full_name.toLowerCase() !== repository) {
    throw new Error(`clean control must be an exact merged PR into the current default branch: ${scenario.scenarioId}`);
  }
  const observationPullMatch = new URL(observation.sourceUrl).pathname.match(/\/pull\/([1-9][0-9]*)\/?$/);
  if (!observationPullMatch) throw new Error(`clean observation PR is invalid: ${scenario.scenarioId}`);
  const observationPullNumber = Number(observationPullMatch[1]);
  if (observationPullNumber === pullNumber) {
    throw new Error(`clean observation PR must be later than the source PR: ${scenario.scenarioId}`);
  }
  const observationPullDocument = await fetchJsonDocument(
    fetchImpl,
    new URL(`https://api.github.com/repos/${repository}/pulls/${observationPullNumber}`),
    MAX_ORACLE_METADATA_BYTES,
    `clean observation PR metadata: ${scenario.scenarioId}`
  );
  const observationPull = requireRecord(observationPullDocument.value, "clean observation PR metadata");
  const observationBase = requireRecord(observationPull.base, "clean observation PR base");
  const observationBaseRepository = requireRecord(
    observationBase.repo,
    "clean observation PR base repository"
  );
  const observationMergeCommitSha = requireSha(
    observationPull.merge_commit_sha,
    "clean observation PR merge commit"
  );
  const observedThrough = normalizeGitHubTimestamp(
    observationPull.merged_at,
    "clean observation PR merged_at"
  );
  if (observationPull.number !== observationPullNumber || observationPull.state !== "closed" ||
      observationPull.merged !== true || observationMergeCommitSha !== observation.sourceRevision ||
      observationBase.ref !== defaultBranch ||
      typeof observationBaseRepository.full_name !== "string" ||
      observationBaseRepository.full_name.toLowerCase() !== repository ||
      observedThrough !== observation.observedThrough) {
    throw new Error(`clean observation must be an exact later PR merged into the same default branch: ${scenario.scenarioId}`);
  }
  if (Date.parse(observedThrough) > Date.parse(normalizedAdmittedAt) ||
      Date.parse(observedThrough) > Date.parse(serverObservedAt) ||
      Date.parse(observedThrough) - Date.parse(mergedAt) < observation.minimumCleanDays * 86_400_000 ||
      Date.parse(normalizedAdmittedAt) - Date.parse(mergedAt) < observation.minimumCleanDays * 86_400_000) {
    throw new Error(`clean observation does not prove the declared post-merge window: ${scenario.scenarioId}`);
  }

  const branchDocument = await fetchJsonDocument(
    fetchImpl,
    new URL(`https://api.github.com/repos/${repository}/branches/${encodeURIComponent(defaultBranch)}`),
    MAX_ORACLE_METADATA_BYTES,
    `clean default branch metadata: ${scenario.scenarioId}`
  );
  const branch = requireRecord(branchDocument.value, "clean default branch metadata");
  const branchCommit = requireRecord(branch.commit, "clean default branch commit");
  const currentDefaultHead = requireSha(branchCommit.sha, "clean default branch head");

  const mergeToObservation = await verifyCleanLineage(
    fetchImpl,
    scenario,
    mergeCommitSha,
    observation.sourceRevision,
    `clean merge-to-observation history: ${scenario.scenarioId}`
  );
  if (observation.sourceRevision !== currentDefaultHead) {
    await verifyAncestry(
      fetchImpl,
      scenario,
      observation.sourceRevision,
      currentDefaultHead,
      `clean observation-to-current ancestry: ${scenario.scenarioId}`
    );
  }
  rejectCorrectiveCommitSignals(mergeToObservation.commits, {
    scenarioId: scenario.scenarioId,
    repository,
    pullNumber,
    sourceRevision: scenario.sourceRevision,
    mergeCommitSha,
    pullTitle: requireNonEmptyString(pull.title, "clean source PR title")
  });

  const timeline = await fetchJsonDocument(
    fetchImpl,
    new URL(`https://api.github.com/repos/${repository}/issues/${pullNumber}/timeline?per_page=100`),
    MAX_COMPARE_METADATA_BYTES,
    `clean source PR timeline: ${scenario.scenarioId}`
  );
  rejectPaginatedEvidence(timeline.headers, `clean source PR timeline: ${scenario.scenarioId}`);
  const timelineProjection = validateCleanTimeline(
    timeline.value,
    mergedAt,
    observedThrough,
    scenario.scenarioId
  );

  const commentsUrl = new URL(`https://api.github.com/repos/${repository}/issues/${pullNumber}/comments`);
  commentsUrl.searchParams.set("per_page", "100");
  commentsUrl.searchParams.set("since", mergedAt);
  const comments = await fetchJsonDocument(
    fetchImpl,
    commentsUrl,
    MAX_COMPARE_METADATA_BYTES,
    `clean source PR comments: ${scenario.scenarioId}`
  );
  rejectPaginatedEvidence(comments.headers, `clean source PR comments: ${scenario.scenarioId}`);
  const commentProjection = validateCleanComments(
    comments.value,
    mergedAt,
    observedThrough,
    scenario.scenarioId
  );

  const diffBytes = await fetchBytes(
    fetchImpl,
    new URL(`https://github.com/${repository}/commit/${observation.sourceRevision}.diff`),
    MAX_ORACLE_SOURCE_BYTES,
    `clean observation diff: ${scenario.scenarioId}`,
    "application/vnd.github.diff"
  );
  rejectSecretOrInvalidUtf8(diffBytes, `clean observation diff: ${scenario.scenarioId}`);
  const sourceEvidenceSha256 = sha256(diffBytes);
  if (sourceEvidenceSha256 !== observation.sourceEvidenceSha256) {
    throw new Error(`clean observation evidence sha256 mismatch: ${scenario.scenarioId}`);
  }
  const metadataSha256 = sha256(stableJson({
    sourceRevision: observation.sourceRevision,
    sourceEvidenceSha256,
    observedThrough,
    minimumCleanDays: observation.minimumCleanDays,
    checkedSignals: observation.checkedSignals,
    defaultBranch,
    pullNumber,
    mergeCommitSha,
    mergedAt,
    observationPullNumber,
    observationMergeCommitSha,
    mergeToObservation,
    historySha256: sha256(stableJson(mergeToObservation.commits)),
    timelineSha256: sha256(stableJson(timelineProjection)),
    commentsSha256: sha256(stableJson(commentProjection))
  }));
  return recordFor(scenario, sourceEvidenceSha256, metadataSha256, observation.sourceRevision);
}

async function verifyAncestry(
  fetchImpl: typeof fetch,
  scenario: ReviewBenchScenarioV1,
  baseRevision: string,
  headRevision: string,
  label: string
): Promise<{ baseSha: string; headSha: string; aheadBy: number; baseCommittedAt: string }> {
  const repository = scenario.repository.toLowerCase();
  const comparison = await fetchJson(
    fetchImpl,
    new URL(`https://api.github.com/repos/${repository}/compare/${baseRevision}...${headRevision}`),
    MAX_COMPARE_METADATA_BYTES,
    label
  );
  const record = requireRecord(comparison, label);
  const baseCommit = requireRecord(record.base_commit, `${label} base commit`);
  const mergeBaseCommit = requireRecord(record.merge_base_commit, `${label} merge base commit`);
  const baseIdentity = requireRecord(baseCommit.commit, `${label} base commit identity`);
  const baseCommitter = requireRecord(baseIdentity.committer, `${label} base committer`);
  const commits = Array.isArray(record.commits) ? record.commits.map((item) => requireRecord(item, `${label} commit`)) : [];
  const head = commits.at(-1);
  if (record.status !== "ahead" || !Number.isSafeInteger(record.ahead_by) || Number(record.ahead_by) < 1 ||
      baseCommit.sha !== baseRevision || mergeBaseCommit.sha !== baseRevision || head?.sha !== headRevision) {
    throw new Error(`${label} must prove the reviewed revision is an ancestor of the evidence revision`);
  }
  return {
    baseSha: baseRevision,
    headSha: headRevision,
    aheadBy: Number(record.ahead_by),
    baseCommittedAt: normalizeGitHubTimestamp(baseCommitter.date, `${label} base committer date`)
  };
}

async function verifyCleanLineage(
  fetchImpl: typeof fetch,
  scenario: ReviewBenchScenarioV1,
  baseRevision: string,
  headRevision: string,
  label: string
): Promise<{
  baseSha: string;
  headSha: string;
  aheadBy: number;
  commits: Array<{ sha: string; message: string }>;
}> {
  if (baseRevision === headRevision) {
    return { baseSha: baseRevision, headSha: headRevision, aheadBy: 0, commits: [] };
  }
  const repository = scenario.repository.toLowerCase();
  const document = await fetchJsonDocument(
    fetchImpl,
    new URL(`https://api.github.com/repos/${repository}/compare/${baseRevision}...${headRevision}`),
    MAX_COMPARE_METADATA_BYTES,
    label
  );
  rejectPaginatedEvidence(document.headers, label);
  const record = requireRecord(document.value, label);
  const baseCommit = requireRecord(record.base_commit, `${label} base commit`);
  const mergeBaseCommit = requireRecord(record.merge_base_commit, `${label} merge base commit`);
  if (!Array.isArray(record.commits)) throw new Error(`${label} commits must be an array`);
  const commits = record.commits.map((item, index) => {
    const commitRecord = requireRecord(item, `${label} commit[${index}]`);
    const identity = requireRecord(commitRecord.commit, `${label} commit[${index}] identity`);
    return {
      sha: requireSha(commitRecord.sha, `${label} commit[${index}] sha`),
      message: requireNonEmptyString(identity.message, `${label} commit[${index}] message`)
    };
  });
  if (record.status !== "ahead" || !Number.isSafeInteger(record.ahead_by) ||
      Number(record.ahead_by) < 1 || Number(record.ahead_by) > 250 ||
      Number(record.ahead_by) !== commits.length || baseCommit.sha !== baseRevision ||
      mergeBaseCommit.sha !== baseRevision || commits.at(-1)?.sha !== headRevision) {
    throw new Error(`${label} must exhaustively prove one current default-branch lineage of at most 250 commits`);
  }
  return { baseSha: baseRevision, headSha: headRevision, aheadBy: commits.length, commits };
}

function rejectCorrectiveCommitSignals(
  commits: ReadonlyArray<{ sha: string; message: string }>,
  source: {
    scenarioId: string;
    repository: string;
    pullNumber: number;
    sourceRevision: string;
    mergeCommitSha: string;
    pullTitle: string;
  }
): void {
  const markers = [
    `#${source.pullNumber}`,
    `${source.repository}#${source.pullNumber}`,
    source.sourceRevision.slice(0, 12),
    source.mergeCommitSha.slice(0, 12),
    source.pullTitle.toLowerCase()
  ];
  for (const commit of commits) {
    const message = commit.message.toLowerCase();
    if (hasCorrectiveSignal(message) && markers.some((marker) => message.includes(marker.toLowerCase()))) {
      throw new Error(`clean history contains a linked corrective commit ${commit.sha}: ${source.scenarioId}`);
    }
  }
}

function validateCleanTimeline(
  value: unknown,
  mergedAt: string,
  observedThrough: string,
  scenarioId: string
): unknown[] {
  if (!Array.isArray(value)) throw new Error(`clean source PR timeline must be an array: ${scenarioId}`);
  const projection: unknown[] = [];
  for (const [index, item] of value.entries()) {
    const event = requireRecord(item, `clean source PR timeline[${index}]`);
    const eventName = requireNonEmptyString(event.event, `clean source PR timeline[${index}].event`);
    const createdAt = event.created_at === null || event.created_at === undefined
      ? null
      : normalizeGitHubTimestamp(event.created_at, `clean source PR timeline[${index}].created_at`);
    if (eventName === "cross-referenced") {
      if (createdAt === null) {
        throw new Error(`clean source PR cross-reference lacks a timestamp: ${scenarioId}`);
      }
      if (Date.parse(createdAt) >= Date.parse(mergedAt)) {
        throw new Error(`clean source PR has a post-merge cross-reference: ${scenarioId}`);
      }
    }
    const sourceIssueUrl = eventName === "cross-referenced"
      ? readCrossReferencedIssueUrl(event.source, `clean source PR timeline[${index}].source`)
      : null;
    if (createdAt !== null && Date.parse(createdAt) <= Date.parse(observedThrough)) {
      projection.push({
        id: typeof event.id === "number" || typeof event.id === "string" ? event.id : null,
        event: eventName,
        createdAt,
        sourceIssueUrl
      });
    }
  }
  return projection;
}

function readCrossReferencedIssueUrl(value: unknown, label: string): string {
  const source = requireRecord(value, label);
  const issue = requireRecord(source.issue, `${label}.issue`);
  const url = requireNonEmptyString(issue.url, `${label}.issue.url`);
  if (!/^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/.test(url)) {
    throw new Error(`${label}.issue.url must be a canonical GitHub issue API URL`);
  }
  return url;
}

function validateCleanComments(
  value: unknown,
  mergedAt: string,
  observedThrough: string,
  scenarioId: string
): unknown[] {
  if (!Array.isArray(value)) throw new Error(`clean source PR comments must be an array: ${scenarioId}`);
  const projection: unknown[] = [];
  for (const [index, item] of value.entries()) {
    const comment = requireRecord(item, `clean source PR comments[${index}]`);
    const createdAt = normalizeGitHubTimestamp(
      comment.created_at,
      `clean source PR comments[${index}].created_at`
    );
    const updatedAt = normalizeGitHubTimestamp(
      comment.updated_at,
      `clean source PR comments[${index}].updated_at`
    );
    if (Date.parse(updatedAt) < Date.parse(createdAt)) {
      throw new Error(`clean source PR comment update precedes creation: ${scenarioId}`);
    }
    const body = requireNonEmptyString(comment.body, `clean source PR comments[${index}].body`);
    if (containsSecretLikeText(body)) {
      throw new Error(`clean source PR comment contains secret-like text: ${scenarioId}`);
    }
    if (Date.parse(updatedAt) >= Date.parse(mergedAt) && hasCorrectiveSignal(body.toLowerCase())) {
      throw new Error(`clean source PR has post-merge corrective discussion: ${scenarioId}`);
    }
    if (Date.parse(createdAt) <= Date.parse(observedThrough)) {
      projection.push({
        id: typeof comment.id === "number" || typeof comment.id === "string" ? comment.id : null,
        createdAt,
        updatedAt,
        bodySha256: sha256(body)
      });
    }
  }
  return projection;
}

function hasCorrectiveSignal(value: string): boolean {
  return /\b(?:revert(?:ed|s|ing)?|hot[- ]?fix|regression|regressed|bug[- ]?fix|fix(?:ed|es|ing)?)\b/i.test(value);
}

function rejectPaginatedEvidence(headers: Headers, label: string): void {
  const link = headers.get("link");
  if (link && /rel="next"/.test(link)) {
    throw new Error(`${label} exceeds the bounded exhaustive page`);
  }
}

function recordFor(
  scenario: ReviewBenchScenarioV1,
  sourceEvidenceSha256: string,
  metadataSha256: string,
  sourceRevision = scenario.oracle.sourceRevision
): ReviewBenchOracleSourceVerificationRecordV1 {
  return {
    schemaVersion: "review-bench-oracle-source-verification/v1",
    verifierVersion: REVIEW_BENCH_ORACLE_SOURCE_VERIFIER_VERSION,
    scenarioId: scenario.scenarioId,
    kind: scenario.oracle.kind,
    sourceRevision,
    sourceEvidenceSha256,
    metadataSha256
  };
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: URL,
  maximumBytes: number,
  label: string
): Promise<unknown> {
  return (await fetchJsonDocument(fetchImpl, url, maximumBytes, label)).value;
}

async function fetchJsonDocument(
  fetchImpl: typeof fetch,
  url: URL,
  maximumBytes: number,
  label: string
): Promise<{ value: unknown; headers: Headers }> {
  const { bytes, headers } = await fetchDocumentBytes(
    fetchImpl,
    url,
    maximumBytes,
    label,
    "application/vnd.github+json"
  );
  try {
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), headers };
  } catch {
    throw new Error(`${label} must be valid UTF-8 JSON`);
  }
}

async function fetchBytes(
  fetchImpl: typeof fetch,
  url: URL,
  maximumBytes: number,
  label: string,
  accept: string
): Promise<Uint8Array> {
  return (await fetchDocumentBytes(fetchImpl, url, maximumBytes, label, accept)).bytes;
}

async function fetchDocumentBytes(
  fetchImpl: typeof fetch,
  url: URL,
  maximumBytes: number,
  label: string,
  accept: string
): Promise<{ bytes: Uint8Array; headers: Headers }> {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    headers: { accept, "user-agent": "neondiff-review-bench-v1" }
  });
  if (!response.ok) throw new Error(`${label} request failed with HTTP ${response.status}`);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
  if (!response.body) throw new Error(`${label} response body is required`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds ${maximumBytes} bytes`);
    }
    chunks.push(value);
  }
  if (total === 0) throw new Error(`${label} response body is empty`);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, headers: response.headers };
}

function rejectSecretOrInvalidUtf8(bytes: Uint8Array, label: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
  if (containsSecretLikeText(text)) throw new Error(`${label} contains secret-like text`);
  return text;
}

function collectUnifiedDiffPaths(diff: string, label: string): Set<string> {
  const paths = new Set<string>();
  let insideFile = false;
  let sawOldHeader = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      insideFile = true;
      sawOldHeader = false;
      continue;
    }
    if (!insideFile) continue;
    if (line.startsWith("@@") || line === "GIT binary patch" || line.startsWith("Binary files ")) {
      insideFile = false;
      continue;
    }
    if (!sawOldHeader && line.startsWith("--- ")) {
      collectHeaderPath(line.slice(4), "a/", paths, label);
      sawOldHeader = true;
      continue;
    }
    if (sawOldHeader && line.startsWith("+++ ")) {
      collectHeaderPath(line.slice(4), "b/", paths, label);
      insideFile = false;
    }
  }
  if (paths.size === 0) throw new Error(`${label} contains no canonical changed paths`);
  return paths;
}

function collectHeaderPath(raw: string, prefix: "a/" | "b/", paths: Set<string>, label: string): void {
  if (raw === "/dev/null") return;
  if (!raw.startsWith(prefix)) throw new Error(`${label} contains a non-canonical diff path`);
  const path = raw.slice(prefix.length);
  if (!isCanonicalPath(path) || path.includes("\t") || path.startsWith('"') || path.endsWith('"')) {
    throw new Error(`${label} contains a non-canonical diff path`);
  }
  paths.add(path);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireShaArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  return value.map((item) => {
    const record = requireRecord(item, label);
    if (typeof record.sha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.sha)) {
      throw new Error(`${label} contains an invalid sha`);
    }
    return record.sha;
  });
}

function normalizeGitHubTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new Error(`${label} must be a UTC RFC3339 timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a UTC RFC3339 timestamp`);
  return new Date(parsed).toISOString();
}

function normalizeGitHubHttpDate(value: string | null, label: string): string {
  if (value === null || !/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    throw new Error(`${label} must be an RFC 7231 Date header`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an RFC 7231 Date header`);
  return new Date(parsed).toISOString();
}

function requireSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error(`${label} must be an immutable hexadecimal digest`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireCanonicalBranchName(value: unknown, label: string): string {
  const branch = requireNonEmptyString(value, label);
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("\\") || branch.includes("\0") ||
      branch.includes("..") || branch.includes("//") || /[\s~^:?*[\]]/.test(branch)) {
    throw new Error(`${label} must be a canonical Git branch name`);
  }
  return branch;
}

function isCanonicalPath(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.startsWith("./") &&
    !value.includes("\\") && !value.includes("\0") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => compareFixed(a, b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareFixed(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
