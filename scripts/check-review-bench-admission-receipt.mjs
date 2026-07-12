import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const MAX_RECEIPT_BYTES = 64 * 1024;
const REQUIRED_KEYS = [
  "schemaVersion",
  "corpusVersion",
  "corpusHash",
  "verificationEvidenceSha256",
  "scenarioCount",
  "sourceVerifierVersion",
  "admittedAt",
  "receiptSha256"
];
const COMPARISON_KEYS = [
  "schemaVersion",
  "corpusVersion",
  "corpusHash",
  "verificationEvidenceSha256",
  "scenarioCount",
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
  scenarioCount: live.scenarioCount
}));

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--live" || argv[2] !== "--committed") {
    throw new Error("usage: --live <live-receipt.json> --committed <committed-receipt.json>");
  }
  return { live: argv[1], committed: argv[3] };
}

function readReceipt(path, label) {
  const stats = statSync(path);
  if (!stats.isFile() || stats.size === 0 || stats.size > MAX_RECEIPT_BYTES) {
    throw new Error(`${label} must contain 1-${MAX_RECEIPT_BYTES} bytes`);
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} must be valid JSON`);
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
      !Number.isSafeInteger(receipt.scenarioCount) || receipt.scenarioCount < 1 ||
      !isIsoTimestamp(receipt.admittedAt) || !/^[a-f0-9]{64}$/.test(receipt.receiptSha256)) {
    throw new Error(`${label} has invalid fields`);
  }
  const { receiptSha256, ...basis } = receipt;
  const expected = createHash("sha256").update(stableJson(basis)).digest("hex");
  if (receiptSha256 !== expected) throw new Error(`${label} receiptSha256 mismatch`);
  return receipt;
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
