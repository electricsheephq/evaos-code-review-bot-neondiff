import { createHash } from "node:crypto";
import {
  computeReviewBenchCorpusHash,
  computeReviewBenchSourceVerificationBinding,
  validateReviewBenchCorpus,
  type ReviewBenchCorpusV1,
  type ReviewBenchScenarioV1,
  type ReviewBenchSourceVerificationV1
} from "./review-bench-corpus.js";
import { containsSecretLikeText } from "./secrets.js";

const MAX_REPOSITORY_METADATA_BYTES = 256 * 1024;
const MAX_SOURCE_METADATA_BYTES = 256 * 1024;
const MAX_LICENSE_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_LICENSE_ARTIFACT_BYTES = 1024 * 1024;
export const REVIEW_BENCH_MAX_SOURCE_ARTIFACT_BYTES = 32 * 1024 * 1024;

export function decodeAndValidateReviewBenchSourceArtifact(
  bytes: Uint8Array,
  label: string
): string {
  if (bytes.byteLength === 0 || bytes.byteLength > REVIEW_BENCH_MAX_SOURCE_ARTIFACT_BYTES) {
    throw new Error(`${label} must contain 1-${REVIEW_BENCH_MAX_SOURCE_ARTIFACT_BYTES} bytes`);
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
  if (containsSecretLikeText(decoded)) throw new Error(`${label} contains secret-like text`);
  return decoded;
}

export async function reverifyReviewBenchCorpusPublicSources(input: {
  corpus: ReviewBenchCorpusV1;
  sourceArtifactFor: (scenario: ReviewBenchScenarioV1) => Uint8Array | Promise<Uint8Array>;
  fetchImpl?: typeof fetch;
}): Promise<{
  corpusHash: string;
  verificationEvidenceSha256: string;
  records: Array<{ scenarioId: string; verification: ReviewBenchSourceVerificationV1 }>;
}> {
  validateReviewBenchCorpus(input.corpus);
  const records: Array<{ scenarioId: string; verification: ReviewBenchSourceVerificationV1 }> = [];
  const scenarios = [...input.corpus.scenarios].sort((a, b) => compareFixed(a.scenarioId, b.scenarioId));
  for (const scenario of scenarios) {
    const sourceArtifact = await input.sourceArtifactFor(scenario);
    const verification = await verifyGitHubReviewBenchSource({
      scenario,
      sourceArtifact,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      verifiedAt: scenario.provenance.verification.verifiedAt
    });
    if (stableJson(verification) !== stableJson(scenario.provenance.verification)) {
      throw new Error(`stored source verification differs from live re-verification: ${scenario.scenarioId}`);
    }
    records.push({ scenarioId: scenario.scenarioId, verification });
  }
  return {
    corpusHash: computeReviewBenchCorpusHash(input.corpus),
    verificationEvidenceSha256: sha256(stableJson(records)),
    records
  };
}

export async function verifyGitHubReviewBenchSource(input: {
  scenario: ReviewBenchScenarioV1;
  sourceArtifact: Uint8Array;
  fetchImpl?: typeof fetch;
  verifiedAt?: string;
}): Promise<ReviewBenchSourceVerificationV1> {
  const { scenario, sourceArtifact } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
  requireIsoTimestamp(verifiedAt, "verifiedAt");
  if (verifiedAt !== scenario.provenance.visibilityVerifiedAt) {
    throw new Error("verifiedAt must equal provenance.visibilityVerifiedAt");
  }
  if (sourceArtifact.byteLength === 0 || sourceArtifact.byteLength > REVIEW_BENCH_MAX_SOURCE_ARTIFACT_BYTES) {
    throw new Error(`source artifact must contain 1-${REVIEW_BENCH_MAX_SOURCE_ARTIFACT_BYTES} bytes`);
  }
  const sourceArtifactSha256 = sha256(sourceArtifact);
  if (sourceArtifactSha256 !== scenario.provenance.sourceArtifactSha256) {
    throw new Error("source artifact sha256 does not match the declared provenance digest");
  }
  decodeAndValidateReviewBenchSourceArtifact(sourceArtifact, `source artifact: ${scenario.scenarioId}`);

  const urls = requireCanonicalGitHubUrls(scenario);
  const metadataResponse = await fetchImpl(urls.visibilityEvidenceUrl, {
    method: "GET",
    redirect: "error",
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "neondiff-review-bench-v1"
    }
  });
  requireOk(metadataResponse, "GitHub repository metadata");
  const metadataBytes = await readBoundedBody(
    metadataResponse,
    MAX_REPOSITORY_METADATA_BYTES,
    "GitHub repository metadata"
  );
  const metadata = parseFatalUtf8Json(metadataBytes, "GitHub repository metadata");
  const proof = parseRepositoryProof(metadata, scenario);
  const sourceMetadataSha256 = await verifySourceMetadata(fetchImpl, scenario);

  const sourceArtifactResponse = await fetchImpl(urls.sourceArtifactUrl, {
    method: "GET",
    redirect: "error",
    headers: {
      accept: "application/vnd.github.diff",
      "user-agent": "neondiff-review-bench-v1"
    }
  });
  requireOk(sourceArtifactResponse, "source artifact");
  const fetchedSourceArtifact = await readBoundedBody(
    sourceArtifactResponse,
    REVIEW_BENCH_MAX_SOURCE_ARTIFACT_BYTES,
    "source artifact"
  );
  if (fetchedSourceArtifact.byteLength === 0 || sha256(fetchedSourceArtifact) !== sourceArtifactSha256) {
    throw new Error("fetched source artifact sha256 does not match supplied artifact bytes");
  }

  const licenseProof = await verifyRevisionLicense(fetchImpl, scenario, urls.declaredLicenseUrl);
  const licenseResponse = await fetchImpl(licenseProof.artifactUrl, {
    method: "GET",
    redirect: "error",
    headers: {
      accept: "text/plain",
      "user-agent": "neondiff-review-bench-v1"
    }
  });
  requireOk(licenseResponse, "license artifact");
  const licenseBytes = await readBoundedBody(
    licenseResponse,
    MAX_LICENSE_ARTIFACT_BYTES,
    "license artifact"
  );
  if (licenseBytes.byteLength === 0) throw new Error("license artifact must not be empty");
  if (sha256(licenseBytes) !== sha256(licenseProof.bytes)) {
    throw new Error("raw license artifact does not match revision-specific GitHub license content");
  }

  const repositoryMetadataSha256 = sha256(JSON.stringify({
    fullName: proof.fullName,
    nodeId: proof.nodeId,
    private: false,
    visibility: "public"
  }));
  const record: ReviewBenchSourceVerificationV1 = {
    schemaVersion: "review-bench-source-verification/v1",
    provider: "github",
    verifierVersion: "github-public-source-ingest/v1",
    repositoryNodeId: proof.nodeId,
    visibility: "public",
    licenseSpdxId: licenseProof.spdxId,
    repositoryMetadataSha256,
    sourceMetadataSha256,
    licenseArtifactSha256: sha256(licenseBytes),
    sourceArtifactSha256,
    verifiedAt,
    bindingSha256: "0".repeat(64)
  };
  const scenarioWithRecord: ReviewBenchScenarioV1 = {
    ...scenario,
    provenance: { ...scenario.provenance, verification: record }
  };
  record.bindingSha256 = computeReviewBenchSourceVerificationBinding(scenarioWithRecord);
  return record;
}

function requireCanonicalGitHubUrls(scenario: ReviewBenchScenarioV1): {
  visibilityEvidenceUrl: URL;
  sourceArtifactUrl: URL;
  declaredLicenseUrl: URL;
} {
  const repository = scenario.repository.trim().toLowerCase();
  const repositoryMatch = /^([a-z0-9](?:[a-z0-9._-]{0,99}))\/([a-z0-9](?:[a-z0-9._-]{0,99}))$/.exec(repository);
  if (!repositoryMatch) throw new Error("repository must be a canonical GitHub owner/name identity");
  const safeRepository = `${repositoryMatch[1]}/${repositoryMatch[2]}`;
  const revision = scenario.sourceRevision.toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) {
    throw new Error("sourceRevision must be an immutable hexadecimal digest");
  }
  const baseRevision = scenario.provenance.baseRevision?.toLowerCase();
  if (scenario.provenance.kind === "pull_request" &&
      (!baseRevision || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseRevision))) {
    throw new Error("pull-request baseRevision must be an immutable hexadecimal digest");
  }
  const repositoryUrl = new URL(scenario.provenance.repositoryUrl);
  const sourceUrl = new URL(scenario.provenance.sourceUrl);
  const declaredSourceArtifactUrl = new URL(scenario.provenance.sourceArtifactUrl);
  const declaredVisibilityEvidenceUrl = new URL(scenario.provenance.visibilityEvidenceUrl);
  const declaredLicenseUrl = new URL(scenario.license.licenseUrl);
  const normalizedPath = (url: URL) => url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  if (repositoryUrl.origin !== "https://github.com" || normalizedPath(repositoryUrl) !== repository) {
    throw new Error("repositoryUrl must be the canonical public GitHub repository URL");
  }
  if (sourceUrl.origin !== "https://github.com" ||
      (normalizedPath(sourceUrl) !== repository && !normalizedPath(sourceUrl).startsWith(`${repository}/`))) {
    throw new Error("sourceUrl must be bound to the canonical GitHub repository");
  }
  const sourcePath = normalizedPath(sourceUrl);
  if ((scenario.provenance.kind === "commit" || scenario.provenance.kind === "revert") &&
      sourcePath !== `${repository}/commit/${scenario.sourceRevision.toLowerCase()}`) {
    throw new Error("sourceUrl commit revision must equal sourceRevision");
  }
  if (scenario.provenance.kind === "pull_request" && !new RegExp(`^${escapeRegExp(repository)}/pull/[1-9][0-9]*$`).test(sourcePath)) {
    throw new Error("pull-request sourceUrl must identify a repository pull request");
  }
  const expectedSourceArtifactPath = scenario.provenance.kind === "pull_request"
    ? `${safeRepository}/compare/${baseRevision}...${revision}.diff`
    : `${safeRepository}/commit/${revision}.diff`;
  if (declaredSourceArtifactUrl.origin !== "https://github.com" ||
      normalizedPath(declaredSourceArtifactUrl) !== expectedSourceArtifactPath) {
    throw new Error("sourceArtifactUrl must identify the immutable sourceRevision diff");
  }
  if (declaredVisibilityEvidenceUrl.origin !== "https://api.github.com" ||
      normalizedPath(declaredVisibilityEvidenceUrl) !== `repos/${safeRepository}`) {
    throw new Error("visibilityEvidenceUrl must be the canonical GitHub repository API URL");
  }
  if (declaredLicenseUrl.origin !== "https://raw.githubusercontent.com" ||
      !normalizedPath(declaredLicenseUrl).startsWith(`${safeRepository}/${revision}/`)) {
    throw new Error("licenseUrl must be an immutable raw GitHub URL bound to sourceRevision");
  }
  for (const [name, url] of [
    ["repositoryUrl", repositoryUrl],
    ["sourceUrl", sourceUrl],
    ["sourceArtifactUrl", declaredSourceArtifactUrl],
    ["visibilityEvidenceUrl", declaredVisibilityEvidenceUrl],
    ["licenseUrl", declaredLicenseUrl]
  ] as const) {
    if (url.username || url.password || url.search || url.hash) {
      throw new Error(`${name} must not contain credentials, query, or fragment`);
    }
  }
  return {
    visibilityEvidenceUrl: new URL(`https://api.github.com/repos/${safeRepository}`),
    sourceArtifactUrl: new URL(`https://github.com/${expectedSourceArtifactPath}`),
    declaredLicenseUrl
  };
}

function parseRepositoryProof(metadata: unknown, scenario: ReviewBenchScenarioV1): {
  fullName: string;
  nodeId: string;
} {
  if (!metadata || typeof metadata !== "object") {
    throw new Error("GitHub repository metadata must be an object");
  }
  const record = metadata as Record<string, unknown>;
  const fullName = record.full_name;
  const nodeId = record.node_id;
  if (typeof fullName !== "string" || fullName.toLowerCase() !== scenario.repository.toLowerCase()) {
    throw new Error("GitHub repository metadata full_name does not match the corpus repository");
  }
  if (record.private !== false || record.visibility !== "public") {
    throw new Error("GitHub metadata must prove a public repository");
  }
  if (typeof nodeId !== "string" || nodeId.trim().length === 0) {
    throw new Error("GitHub repository metadata node_id is required");
  }
  return { fullName, nodeId };
}

async function verifySourceMetadata(
  fetchImpl: typeof fetch,
  scenario: ReviewBenchScenarioV1
): Promise<string> {
  const repository = scenario.repository.toLowerCase();
  if (scenario.provenance.kind === "pull_request") {
    const match = new URL(scenario.provenance.sourceUrl).pathname.match(/\/pull\/([1-9][0-9]*)\/?$/);
    if (!match) throw new Error("pull-request sourceUrl must include a pull request number");
    const pullNumber = Number(match[1]);
    const response = await fetchImpl(new URL(`https://api.github.com/repos/${repository}/pulls/${pullNumber}`), {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "neondiff-review-bench-v1"
      }
    });
    const metadata = await readJsonResponse(response, MAX_SOURCE_METADATA_BYTES, "GitHub pull request metadata");
    const record = requireRecord(metadata, "GitHub pull request metadata");
    const base = requireRecord(record.base, "GitHub pull request base");
    const baseRepository = requireRecord(base.repo, "GitHub pull request base repository");
    if (record.number !== pullNumber || typeof baseRepository.full_name !== "string" ||
        baseRepository.full_name.toLowerCase() !== repository) {
      throw new Error("GitHub pull request metadata does not bind the repository PR identity");
    }
    if (record.state !== "closed" || record.merged !== true) {
      throw new Error("GitHub pull request metadata must prove the PR is closed and merged");
    }
    const mergedAt = normalizeGitHubTimestamp(
      record.merged_at,
      "GitHub pull request metadata merged_at"
    );
    const commitsUrl = new URL(`https://api.github.com/repos/${repository}/pulls/${pullNumber}/commits`);
    commitsUrl.searchParams.set("per_page", "100");
    const commitsResponse = await fetchImpl(commitsUrl, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "neondiff-review-bench-v1"
      }
    });
    const commitsValue = await readJsonResponse(
      commitsResponse,
      MAX_SOURCE_METADATA_BYTES,
      "GitHub pull request commits"
    );
    if (commitsResponse.headers.get("link")?.includes('rel="next"')) {
      throw new Error("GitHub pull request commits must fit one bounded exhaustive page");
    }
    if (!Array.isArray(commitsValue) || commitsValue.length === 0 || commitsValue.length > 100) {
      throw new Error("GitHub pull request commits must contain 1-100 entries");
    }
    const commitShas = commitsValue.map((value, index) => {
      const commit = requireRecord(value, `GitHub pull request commits[${index}]`);
      if (typeof commit.sha !== "string" || !/^[a-f0-9]{40,64}$/.test(commit.sha)) {
        throw new Error(`GitHub pull request commits[${index}].sha must be an immutable revision`);
      }
      return commit.sha;
    });
    if (new Set(commitShas).size !== commitShas.length) {
      throw new Error("GitHub pull request commits must be unique");
    }
    if (commitShas.at(-1) !== scenario.sourceRevision) {
      throw new Error("GitHub pull request final PR commit does not equal sourceRevision");
    }
    return sha256(stableJson({
      kind: "pull_request",
      pullNumber,
      pinnedHeadSha: scenario.sourceRevision,
      pinnedBaseSha: scenario.provenance.baseRevision,
      commitShas,
      baseRepository: baseRepository.full_name.toLowerCase(),
      state: record.state,
      merged: record.merged,
      mergedAt
    }));
  }

  const response = await fetchImpl(
    new URL(`https://api.github.com/repos/${repository}/commits/${scenario.sourceRevision}`),
    {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "neondiff-review-bench-v1"
      }
    }
  );
  const metadata = await readJsonResponse(response, MAX_SOURCE_METADATA_BYTES, "GitHub commit metadata");
  const record = requireRecord(metadata, "GitHub commit metadata");
  if (record.sha !== scenario.sourceRevision) {
    throw new Error("GitHub commit metadata sha does not equal sourceRevision");
  }
  return sha256(stableJson({ kind: scenario.provenance.kind, sha: record.sha }));
}

async function verifyRevisionLicense(
  fetchImpl: typeof fetch,
  scenario: ReviewBenchScenarioV1,
  declaredLicenseUrl: URL
): Promise<{ spdxId: string; bytes: Uint8Array; artifactUrl: URL }> {
  const repository = scenario.repository.toLowerCase();
  const endpoint = new URL(`https://api.github.com/repos/${repository}/license`);
  endpoint.searchParams.set("ref", scenario.sourceRevision);
  const response = await fetchImpl(endpoint, {
    method: "GET",
    redirect: "error",
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "neondiff-review-bench-v1"
    }
  });
  const metadata = await readJsonResponse(response, MAX_LICENSE_METADATA_BYTES, "GitHub revision license metadata");
  const record = requireRecord(metadata, "GitHub revision license metadata");
  const license = requireRecord(record.license, "GitHub revision license identity");
  if (typeof license.spdx_id !== "string" || license.spdx_id !== scenario.license.spdxId) {
    throw new Error("GitHub revision license SPDX does not match the corpus license");
  }
  if (record.encoding !== "base64" || typeof record.content !== "string" ||
      typeof record.path !== "string" || record.path.trim().length === 0) {
    throw new Error("GitHub revision license metadata must include base64 content and path");
  }
  const encodedPath = record.path.split("/").map((segment) => {
    if (segment.length === 0 || segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0")) {
      throw new Error("GitHub revision license path must be canonical");
    }
    return encodeURIComponent(segment);
  }).join("/");
  const expectedLicenseUrl = new URL(
    `https://raw.githubusercontent.com/${repository}/${scenario.sourceRevision}/${encodedPath}`
  );
  if (declaredLicenseUrl.toString() !== expectedLicenseUrl.toString()) {
    throw new Error("licenseUrl must match the revision-specific GitHub license path");
  }
  const bytes = new Uint8Array(Buffer.from(record.content.replace(/\s+/g, ""), "base64"));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_LICENSE_ARTIFACT_BYTES) {
    throw new Error("GitHub revision license content is empty or oversized");
  }
  return { spdxId: license.spdx_id, bytes, artifactUrl: expectedLicenseUrl };
}

async function readJsonResponse(response: Response, maximumBytes: number, label: string): Promise<unknown> {
  requireOk(response, label);
  const bytes = await readBoundedBody(response, maximumBytes, label);
  return parseFatalUtf8Json(bytes, label);
}

function parseFatalUtf8Json(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} must be valid UTF-8 JSON`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function readBoundedBody(response: Response, maximumBytes: number, label: string): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
  if (!response.body) return new Uint8Array();
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
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function requireOk(response: Response, label: string): void {
  if (!response.ok) throw new Error(`${label} request failed with HTTP ${response.status}`);
}

function requireIsoTimestamp(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
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

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => compareFixed(a, b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareFixed(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
