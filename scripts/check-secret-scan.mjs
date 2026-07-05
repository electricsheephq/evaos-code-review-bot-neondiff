import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const json = process.argv.includes("--json");
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);

const patterns = [
  ["private_key", /-----BEGIN (?:RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----/],
  ["github_token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/],
  ["github_pat", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ["openai_key", /\bsk-[A-Za-z0-9]{20,}\b/],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["stripe_secret_key", /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ["npm_token", /\bnpm_[A-Za-z0-9]{20,}\b/]
];

const binaryExt = /\.(?:ico|png|jpg|jpeg|gif|woff2?|ttf|otf|pdf|zip|gz|tgz)$/i;
const findings = [];

for (const file of files) {
  if (binaryExt.test(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const [name, pattern] of patterns) {
      if (pattern.test(line)) findings.push({ file, line: index + 1, pattern: name });
    }
  });
}

const envTracked = files.filter((file) => /(^|\/)\.env(?:\.|$)/.test(file));
const sensitiveTracked = files.filter((file) => /\.(?:pem|key|sqlite|db)$/.test(file));
const result = {
  ok: findings.length === 0 && envTracked.length === 0 && sensitiveTracked.length === 0,
  findings,
  envTracked,
  sensitiveTracked,
  scannedFiles: files.length
};

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.ok) {
  console.log(`secret scan ok: ${files.length} tracked files`);
} else {
  console.error(JSON.stringify(result, null, 2));
}

if (!result.ok) process.exit(1);
