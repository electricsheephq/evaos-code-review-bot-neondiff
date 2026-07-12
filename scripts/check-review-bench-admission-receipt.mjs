import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync
} from "node:fs";

const MAX_RECEIPT_BYTES = 64 * 1024;
const REQUIRED_KEYS = [
  "schemaVersion",
  "corpusVersion",
  "corpusHash",
  "verificationEvidenceSha256",
  "semanticEvidenceVersion",
  "semanticEvidenceVerifierVersion",
  "semanticEvidenceSha256",
  "oracleSourceVerifierVersion",
  "oracleSourceVerificationSha256",
  "adjudicationAgreementVersion",
  "adjudicationScenarioCount",
  "actionabilityItemCount",
  "actionabilityBothActionableCount",
  "actionabilityPrimaryOnlyCount",
  "actionabilitySecondaryOnlyCount",
  "actionabilityNeitherCount",
  "actionabilityKappa",
  "artifactBothDefectCount",
  "artifactPrimaryOnlyDefectCount",
  "artifactSecondaryOnlyDefectCount",
  "artifactBothCleanCount",
  "artifactSemanticsKappa",
  "p0p1LabelCount",
  "severityAgreementLabelCount",
  "severityWithinOneTierAgreement",
  "scenarioCount",
  "defectScenarioCount",
  "cleanControlCount",
  "languageCount",
  "repositoryCount",
  "sourceVerifierVersion",
  "admittedAt",
  "receiptSha256"
];
const COMPARISON_KEYS = [
  "schemaVersion",
  "corpusVersion",
  "corpusHash",
  "verificationEvidenceSha256",
  "semanticEvidenceVersion",
  "semanticEvidenceVerifierVersion",
  "semanticEvidenceSha256",
  "oracleSourceVerifierVersion",
  "oracleSourceVerificationSha256",
  "adjudicationAgreementVersion",
  "adjudicationScenarioCount",
  "actionabilityItemCount",
  "actionabilityBothActionableCount",
  "actionabilityPrimaryOnlyCount",
  "actionabilitySecondaryOnlyCount",
  "actionabilityNeitherCount",
  "actionabilityKappa",
  "artifactBothDefectCount",
  "artifactPrimaryOnlyDefectCount",
  "artifactSecondaryOnlyDefectCount",
  "artifactBothCleanCount",
  "artifactSemanticsKappa",
  "p0p1LabelCount",
  "severityAgreementLabelCount",
  "severityWithinOneTierAgreement",
  "scenarioCount",
  "defectScenarioCount",
  "cleanControlCount",
  "languageCount",
  "repositoryCount",
  "sourceVerifierVersion"
];

const args = parseArgs(process.argv.slice(2));
const live = readReceipt(args.live, "live receipt");
const committed = readReceipt(args.committed, "committed receipt");
for (const key of COMPARISON_KEYS) {
  if (live[key] !== committed[key]) throw new Error(`receipt mismatch for ${key}`);
}
console.log(JSON.stringify({
  ok: true,
  corpusHash: live.corpusHash,
  verificationEvidenceSha256: live.verificationEvidenceSha256,
  semanticEvidenceVersion: live.semanticEvidenceVersion,
  semanticEvidenceVerifierVersion: live.semanticEvidenceVerifierVersion,
  semanticEvidenceSha256: live.semanticEvidenceSha256,
  oracleSourceVerifierVersion: live.oracleSourceVerifierVersion,
  oracleSourceVerificationSha256: live.oracleSourceVerificationSha256,
  adjudicationAgreementVersion: live.adjudicationAgreementVersion,
  actionabilityItemCount: live.actionabilityItemCount,
  actionabilityKappa: live.actionabilityKappa,
  artifactSemanticsKappa: live.artifactSemanticsKappa,
  p0p1LabelCount: live.p0p1LabelCount,
  severityWithinOneTierAgreement: live.severityWithinOneTierAgreement,
  scenarioCount: live.scenarioCount
}));

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--live" || argv[2] !== "--committed") {
    throw new Error("usage: --live <live-receipt.json> --committed <committed-receipt.json>");
  }
  return { live: argv[1], committed: argv[3] };
}

function readReceipt(path, label) {
  const bytes = readBoundedRegularFile(path, label);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8 JSON`);
  }
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (text !== `${stableJson(receipt)}\n`) {
    throw new Error(`${label} must use canonical JSON without duplicate keys`);
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(receipt).sort();
  if (stableJson(keys) !== stableJson([...REQUIRED_KEYS].sort())) {
    throw new Error(`${label} has missing or unknown keys`);
  }
  if (receipt.schemaVersion !== "review-bench-source-admission-receipt/v1" ||
      receipt.sourceVerifierVersion !== "github-public-source-ingest/v1" ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(receipt.corpusVersion) ||
      !/^[a-f0-9]{64}$/.test(receipt.corpusHash) ||
      !/^[a-f0-9]{64}$/.test(receipt.verificationEvidenceSha256) ||
      receipt.semanticEvidenceVersion !== "review-bench-oracle-evidence/v2" ||
      receipt.semanticEvidenceVerifierVersion !== "review-bench-semantic-admission/v3" ||
      !/^[a-f0-9]{64}$/.test(receipt.semanticEvidenceSha256) ||
      receipt.oracleSourceVerifierVersion !== "github-oracle-source-verifier/v2" ||
      !/^[a-f0-9]{64}$/.test(receipt.oracleSourceVerificationSha256) ||
      receipt.adjudicationAgreementVersion !== "review-bench-adjudication-agreement/v3" ||
      !Number.isSafeInteger(receipt.adjudicationScenarioCount) || receipt.adjudicationScenarioCount < 2 ||
      receipt.adjudicationScenarioCount !== receipt.scenarioCount ||
      !Number.isSafeInteger(receipt.actionabilityItemCount) || receipt.actionabilityItemCount < 150 ||
      !isNonNegativeInteger(receipt.actionabilityBothActionableCount) ||
      !isNonNegativeInteger(receipt.actionabilityPrimaryOnlyCount) ||
      !isNonNegativeInteger(receipt.actionabilitySecondaryOnlyCount) ||
      !isNonNegativeInteger(receipt.actionabilityNeitherCount) ||
      receipt.actionabilityBothActionableCount < 25 || receipt.actionabilityNeitherCount < 25 ||
      receipt.actionabilityBothActionableCount + receipt.actionabilityPrimaryOnlyCount +
        receipt.actionabilitySecondaryOnlyCount + receipt.actionabilityNeitherCount !==
        receipt.actionabilityItemCount ||
      typeof receipt.actionabilityKappa !== "number" || !Number.isFinite(receipt.actionabilityKappa) ||
      receipt.actionabilityKappa < 0.70 || receipt.actionabilityKappa > 1 ||
      !isNonNegativeInteger(receipt.artifactBothDefectCount) ||
      !isNonNegativeInteger(receipt.artifactPrimaryOnlyDefectCount) ||
      !isNonNegativeInteger(receipt.artifactSecondaryOnlyDefectCount) ||
      !isNonNegativeInteger(receipt.artifactBothCleanCount) ||
      receipt.artifactBothDefectCount + receipt.artifactPrimaryOnlyDefectCount +
        receipt.artifactSecondaryOnlyDefectCount + receipt.artifactBothCleanCount !== receipt.scenarioCount ||
      typeof receipt.artifactSemanticsKappa !== "number" ||
      !Number.isFinite(receipt.artifactSemanticsKappa) ||
      receipt.artifactSemanticsKappa < 0.70 || receipt.artifactSemanticsKappa > 1 ||
      !Number.isSafeInteger(receipt.p0p1LabelCount) || receipt.p0p1LabelCount < 30 ||
      !Number.isSafeInteger(receipt.severityAgreementLabelCount) || receipt.severityAgreementLabelCount < 1 ||
      typeof receipt.severityWithinOneTierAgreement !== "number" ||
      !Number.isFinite(receipt.severityWithinOneTierAgreement) ||
      receipt.severityWithinOneTierAgreement < 0.85 || receipt.severityWithinOneTierAgreement > 1 ||
      !Number.isSafeInteger(receipt.scenarioCount) || receipt.scenarioCount < 150 ||
      !Number.isSafeInteger(receipt.defectScenarioCount) || receipt.defectScenarioCount < 125 ||
      !Number.isSafeInteger(receipt.cleanControlCount) || receipt.cleanControlCount < 25 ||
      receipt.defectScenarioCount + receipt.cleanControlCount !== receipt.scenarioCount ||
      !Number.isSafeInteger(receipt.languageCount) || receipt.languageCount < 6 ||
      !Number.isSafeInteger(receipt.repositoryCount) || receipt.repositoryCount < 10 ||
      !isIsoTimestamp(receipt.admittedAt) || !/^[a-f0-9]{64}$/.test(receipt.receiptSha256)) {
    throw new Error(`${label} has invalid fields`);
  }
  const { receiptSha256, ...basis } = receipt;
  const expected = createHash("sha256").update(stableJson(basis)).digest("hex");
  if (receiptSha256 !== expected) throw new Error(`${label} receiptSha256 mismatch`);
  return receipt;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function readBoundedRegularFile(path, label) {
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size === 0 || before.size > MAX_RECEIPT_BYTES) {
      throw new Error(`${label} must contain 1-${MAX_RECEIPT_BYTES} bytes`);
    }
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) throw new Error(`${label} changed while being read`);
      offset += bytesRead;
    }
    const after = fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error(`${label} changed while being read`);
    }
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
